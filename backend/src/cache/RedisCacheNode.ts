/**
 * RedisCacheNode — a thin, resilient wrapper around ONE ioredis client.
 *
 * Each instance represents a single logical cache node {id, host, port} that sits at
 * one physical position-set on our consistent-hash ring. CacheService owns a Map of
 * these (one per Redis container) and routes each prefix to exactly one of them.
 *
 * The headline design choice here is RESILIENCE: a typeahead suggestion is a cache,
 * not the source of truth (Postgres + the trie are). So if a Redis node is unreachable,
 * the correct behaviour is to degrade to a *cache miss* — the request then rebuilds the
 * answer from the trie — rather than to throw and 500 the user's keystroke. This keeps
 * the read path available even when a cache node is down, at the cost of slower (DB-backed)
 * responses during the outage. Every method below honours that contract.
 */

import { Redis } from "ioredis";

export class RedisCacheNode {
  /** Stable logical id used as the ring key for this node (e.g. "redis-0"). */
  public readonly id: string;
  public readonly host: string;
  public readonly port: number;

  /** The single ioredis connection this node owns. */
  private readonly client: Redis;

  constructor(id: string, host: string, port: number) {
    this.id = id;
    this.host = host;
    this.port = port;

    this.client = new Redis({
      host,
      port,

      // Lazy connect: don't open a socket in the constructor. We build all three nodes at
      // boot, possibly before Docker Redis is ready; connecting explicitly (see connect()) avoids
      // a boot-time crash and lets a late-starting Redis heal in. CacheService.init() awaits
      // connect() once at startup so we never serve the spurious warm-up miss described below.
      lazyConnect: true,

      // Bound how long a single command waits before we treat the node as unreachable. Without
      // this, a hung Redis would stall a keystroke for ioredis's long default — we'd rather take
      // the miss fast (200ms) and answer from the trie. 200ms >> normal Redis latency (sub-ms),
      // so this only ever fires on a genuine outage, not on healthy slow paths.
      commandTimeout: 200,

      // Cap reconnection backoff: keep retrying a downed node (so it auto-heals) but never wait
      // more than 2s between attempts, so recovery is quick once the container comes back.
      retryStrategy: (attempt: number) => Math.min(attempt * 100, 2000),

      // Retry a command at most once before failing — fast failure into the miss path on a real
      // outage, without giving up on the very first transient blip.
      maxRetriesPerRequest: 1,

      // Offline queue ON (this is the warm-up-miss fix): if a command is issued before the socket
      // is ready, ioredis queues it and runs it the instant the connection is ready instead of
      // rejecting immediately with "Stream isn't writeable". Combined with the explicit connect()
      // at boot this means the first read on a HEALTHY node is a real hit/miss, never a spurious
      // miss. On a genuinely DOWN node, maxRetriesPerRequest:1 + commandTimeout:200 still bound the
      // wait so we degrade to a miss fast rather than buffering keystrokes forever.
      enableOfflineQueue: true,
    });

    // Log connection errors once, but DO NOT crash: an unhandled 'error' event would take down
    // the whole API. Swallowing-with-a-log here is what makes the miss-on-down contract safe.
    this.client.on("error", (err: Error) => {
      console.warn(`[cache:${this.id}] Redis error (treating reads as misses): ${err.message}`);
    });
  }

  /**
   * Open the connection explicitly and wait until it is ready (or fail fast if the node is down).
   * Called once by CacheService.init() at boot so the first real request never hits the connection
   * warm-up window. Safe to call on a down node: it rejects/logs and we proceed (reads degrade to
   * misses). Returns true if the node became ready, false if it could not connect right now.
   */
  async connect(): Promise<boolean> {
    try {
      // With lazyConnect, .connect() actually opens the socket and resolves on 'ready'.
      await this.client.connect();
      return true;
    } catch (err) {
      // Node not up yet — not fatal. retryStrategy keeps trying in the background; meanwhile reads
      // degrade to misses and self-heal once the node is ready.
      console.warn(`[cache:${this.id}] initial connect failed (will retry in background): ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Read a key. Returns the stored string, or null on a miss.
   *
   * "Miss" deliberately covers BOTH cases: the key genuinely isn't there, and Redis is
   * unreachable. The caller (CacheService) can't tell them apart and shouldn't need to —
   * either way it falls back to the trie. We log the unreachable case so an outage is visible
   * in the metrics/logs without breaking the request.
   */
  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (err) {
      console.warn(`[cache:${this.id}] get("${key}") failed, returning miss: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Write a key with a TTL, using SET key value EX ttlSeconds.
   *
   * WHY EX (server-side expiry) instead of tracking expiry ourselves: Redis evicts the key
   * automatically, so a stale prefix result can never outlive its TTL even if our process
   * restarts or never explicitly invalidates it. The TTL is the staleness *bound*; explicit
   * invalidation on batch-flush (see CacheService) is the fast path for known-stale entries.
   *
   * A failed write is non-fatal: the value simply isn't cached, so the next read takes a miss
   * and rebuilds from the trie. We must never let a cache-write error abort a user request.
   */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, "EX", ttlSeconds);
    } catch (err) {
      console.warn(`[cache:${this.id}] set("${key}") failed, skipping cache write: ${(err as Error).message}`);
    }
  }

  /**
   * Delete a key (used by invalidation when rankings change on batch-flush).
   *
   * A failed delete is non-fatal but does mean a stale entry may linger until its TTL fires —
   * which is acceptable precisely because the TTL caps the staleness regardless. We log it.
   */
  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      console.warn(`[cache:${this.id}] del("${key}") failed, entry will expire via TTL: ${(err as Error).message}`);
    }
  }

  /**
   * Health probe for the node. Returns true if Redis answered PONG, false if unreachable.
   * Used by `/metrics` / `/cache/debug` and tests to show which nodes are live without
   * throwing — same miss-on-down philosophy as get().
   */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.client.ping();
      return reply === "PONG";
    } catch (err) {
      console.warn(`[cache:${this.id}] ping failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Close the connection cleanly. Called when a node is removed from the ring (live
   * rebalancing demo) and on process shutdown, so we don't leak sockets.
   */
  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // If quit() itself fails (already disconnected), force the socket shut. Nothing to recover.
      this.client.disconnect();
    }
  }
}
