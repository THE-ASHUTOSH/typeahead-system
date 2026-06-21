/**
 * CacheService — the distributed cache facade the routes use.
 *
 * It is the only thing routes talk to for caching. Internally it owns:
 *   1. a ConsistentHashRing built over our Redis node IDs (the ring is OUR code, so
 *      `/cache/debug` can explain exactly why a prefix landed on a given node), and
 *   2. a Map<nodeId, RedisCacheNode> — one live ioredis wrapper per Redis container.
 *
 * For any prefix the flow is: normalise → ring.getNode(key) → that node's Redis.
 * The same key always hashes to the same node (until the node set changes), so a hot
 * prefix is cached on exactly one node and we get a real distributed cache, not three
 * copies.
 *
 * ── Cache-aside pattern (read path) ──────────────────────────────────────────────
 * The route, not this service, owns the fallback. The contract is the classic
 * cache-aside (lazy-loading) shape:
 *
 *     const { hit, value } = await cache.getSuggestions(prefix);
 *     if (hit) return value;                       // cache served it
 *     const fresh = trie.topK(prefix);             // MISS → load from source of truth
 *     await cache.setSuggestions(prefix, fresh);   // populate cache with a TTL
 *     return fresh;
 *
 * We chose cache-aside (over write-through) because the trie/DB is the authority and the
 * cache only memoises *derived* top-K results; the cache is allowed to be empty or stale,
 * and a miss is always safely recoverable from the trie. Keeping the fallback in the route
 * also keeps this service free of any trie/DB dependency, so it stays unit-testable in isolation.
 *
 * ── Invalidation on flush (write path) ───────────────────────────────────────────
 * When the BatchWriter flushes new counts, the rankings for the affected prefixes change,
 * so their cached top-K is now wrong. The flush calls `invalidate(prefix)` to DEL the owning
 * node's key. Combined with the TTL this is belt-and-braces: invalidate is the *fast* path
 * (stale entry gone immediately), TTL is the *safety net* (anything we miss expires within
 * cacheTtlSeconds). We prefer DEL-on-change over rewriting the entry because recomputing the
 * new top-K here would couple the cache to the ranking; instead we just drop it and let the
 * next read repopulate it lazily via cache-aside.
 */

import { config } from "../config.js";
import { ConsistentHashRing } from "./ConsistentHashRing.js";
import { RedisCacheNode } from "./RedisCacheNode.js";
import { recordHit, recordMiss } from "../metrics/cacheMetrics.js";
import type { Suggestion } from "./types.js";

/** Result of a cache read: whether it hit, which node served/owns it, and the value (null on miss). */
export interface CacheReadResult {
  hit: boolean;
  node: string;
  value: Suggestion[] | null;
}

/** What `/cache/debug?prefix=` reports: the routing decision plus current hit/miss. */
export interface CacheDebugInfo {
  prefix: string;
  /** The normalised, namespaced key actually used in Redis (what the ring hashed). */
  key: string;
  /** Physical Redis node ID the ring assigned this prefix to. */
  owningNode: string;
  /** The prefix's position on the hash ring (for explaining placement in the viva/demo). */
  ringPosition: number;
  /** Whether that node currently holds a (live, parseable) entry for this prefix. */
  hit: boolean;
}

export class CacheService {
  private readonly ring: ConsistentHashRing;
  private readonly nodes: Map<string, RedisCacheNode>;
  private readonly ttlSeconds: number;

  constructor() {
    // TTL comes from config (60s by default): the staleness bound for any cached prefix.
    this.ttlSeconds = config.cacheTtlSeconds;

    // Build one RedisCacheNode per configured Redis container and give each a stable ID.
    // We derive IDs as "redis-0", "redis-1", ... — stable across restarts (config order is
    // fixed) so the ring placement is reproducible and demos are deterministic.
    this.nodes = new Map<string, RedisCacheNode>();
    const nodeIds: string[] = [];
    config.redisNodes.forEach((n, i) => {
      const id = `redis-${i}`;
      nodeIds.push(id);
      this.nodes.set(id, new RedisCacheNode(id, n.host, n.port));
    });

    // The ring is built over the node IDs (strings), NOT the RedisCacheNode objects: the ring
    // is pure routing logic and must stay testable without any Redis. ringVirtualNodes (150 from
    // config) is the per-node virtual-node count that smooths key distribution across only 3 nodes.
    this.ring = new ConsistentHashRing(nodeIds, config.ringVirtualNodes);
  }

  /**
   * Open every node's connection once at boot and wait for them to become ready.
   *
   * WHY: nodes use lazyConnect, so without this the FIRST command on a healthy node would run
   * during the connection warm-up window. Pre-connecting here guarantees the first real /suggest
   * read is a genuine hit/miss, not a spurious warm-up miss that would skew the hit-rate metric.
   * Down nodes don't block boot — connect() resolves false and they heal in the background.
   * Call this from the server bootstrap before accepting traffic.
   */
  async init(): Promise<void> {
    await Promise.all([...this.nodes.values()].map((node) => node.connect()));
  }

  /**
   * Build the Redis key for a prefix: normalise (trim + lowercase) and namespace it.
   *
   * Normalisation must match the read path's normalisation exactly, or "iPhone" and "iphone"
   * would cache separately and halve the hit rate. The "suggest:" namespace prevents collisions
   * if we ever cache other kinds of values in the same Redis instances.
   */
  cacheKey(prefix: string): string {
    return `suggest:${prefix.trim().toLowerCase()}`;
  }

  /**
   * Parse a raw cached string into a validated Suggestion[], or null if it is not a structurally
   * valid entry. JSON.parse alone is not enough: a syntactically valid but structurally wrong value
   * ('5', '"x"', '{}', '[{"foo":1}]') would parse fine yet is NOT a Suggestion[]. Returning such a
   * value would be a false HIT serving malformed data (e.g. an old serialization format after a
   * deploy, or a poisoned key). So both the read path and /cache/debug validate the shape here and
   * treat anything malformed as a miss, so the entry self-heals on the next set().
   */
  private parseEntry(raw: string): Suggestion[] | null {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null; // not even valid JSON.
    }
    if (
      !Array.isArray(value) ||
      !value.every(
        (s) => s !== null && typeof s === "object" && typeof (s as Suggestion).query === "string" && typeof (s as Suggestion).score === "number",
      )
    ) {
      return null; // valid JSON but not the {query:string, score:number}[] shape we cache.
    }
    return value as Suggestion[];
  }

  /** Look up the RedisCacheNode the ring assigns to a given key. */
  private nodeForKey(key: string): { id: string; node: RedisCacheNode } {
    const id = this.ring.getNode(key);
    const node = this.nodes.get(id);
    // This should be impossible (the ring only ever returns IDs we registered), but TS can't
    // prove it and a silent undefined would be a nasty bug, so we fail loudly if it ever happens.
    if (!node) {
      throw new Error(`Ring returned unknown node id "${id}" for key "${key}"`);
    }
    return { id, node };
  }

  /**
   * Read cached suggestions for a prefix (the cache-aside READ step).
   *
   * Routes the key via the ring, reads from the owning node, and JSON-parses. Records the
   * outcome in the shared hit/miss counters. A miss (absent key, unreachable Redis, or
   * corrupt/unparseable JSON) returns { hit:false, value:null } so the route falls back to the trie.
   */
  async getSuggestions(prefix: string): Promise<CacheReadResult> {
    const key = this.cacheKey(prefix);
    const { id, node } = this.nodeForKey(key);

    const raw = await node.get(key); // null on genuine miss OR on Redis-down (see RedisCacheNode)
    if (raw === null) {
      recordMiss();
      return { hit: false, node: id, value: null };
    }

    const value = this.parseEntry(raw);
    if (value === null) {
      // Corrupt/malformed entry → treat as a miss so we self-heal by repopulating on the next set,
      // rather than serving garbage. Counts as a miss for honest hit-rate reporting.
      console.warn(`[cache] corrupt entry for key "${key}", treating as miss`);
      recordMiss();
      return { hit: false, node: id, value: null };
    }
    recordHit();
    return { hit: true, node: id, value };
  }

  /**
   * Populate the cache for a prefix (the cache-aside POPULATE step), with the configured TTL.
   * Called by the route after a miss once it has rebuilt the top-K from the trie.
   */
  async setSuggestions(prefix: string, suggestions: Suggestion[]): Promise<void> {
    const key = this.cacheKey(prefix);
    const { node } = this.nodeForKey(key);
    // Serialise to JSON: Redis stores strings, and JSON round-trips the {query,score} shape cleanly.
    await node.set(key, JSON.stringify(suggestions), this.ttlSeconds);
  }

  /**
   * Invalidate a prefix's cached entry (the invalidation-on-flush step). DELs the key on its
   * owning node so the next read misses and repopulates with fresh rankings. Safe no-op if the
   * key is already gone or Redis is down — the TTL still bounds staleness either way.
   */
  async invalidate(prefix: string): Promise<void> {
    const key = this.cacheKey(prefix);
    const { node } = this.nodeForKey(key);
    await node.del(key);
  }

  /**
   * Debug info for `GET /cache/debug?prefix=`: shows the routing decision (which node owns the
   * prefix and its ring position) and whether that node currently has a live entry. This is the
   * endpoint that *proves* consistent hashing is working, so it surfaces the ring's own numbers.
   */
  async debug(prefix: string): Promise<CacheDebugInfo> {
    const key = this.cacheKey(prefix);
    // getNodePosition returns the full diagnostic record ({keyHash, ringPosition, node, ...});
    // we surface owningNode + ringPosition from it so /cache/debug shows the actual routing.
    const position = this.ring.getNodePosition(key);
    const owningNode = position.node;
    const ringPosition = position.ringPosition;

    // A read-only check that uses the SAME parse+validate logic as getSuggestions(), so "hit" on
    // /cache/debug means exactly what it means on the real read path: a present AND structurally
    // valid entry. (A present-but-corrupt key reports hit:false here, matching the read path,
    // instead of misleadingly showing hit:true on mere key-presence.)
    const node = this.nodes.get(owningNode);
    const raw = node ? await node.get(key) : null;
    const hit = raw !== null && this.parseEntry(raw) !== null;

    return { prefix, key, owningNode, ringPosition, hit };
  }

  /**
   * Add a Redis node at runtime: register its ioredis wrapper AND add it to the ring. Exposed so
   * the demo can show consistent hashing rebalancing live — adding a node moves only a small
   * fraction of keys (the ring's headline property), which we can observe via /cache/debug.
   */
  addNode(id: string, host: string, port: number): void {
    if (this.nodes.has(id)) {
      throw new Error(`Cache node "${id}" already exists`);
    }
    this.nodes.set(id, new RedisCacheNode(id, host, port));
    this.ring.addNode(id);
  }

  /**
   * Remove a Redis node at runtime: drop it from the ring (so its keys re-home to neighbours)
   * and close its connection so we don't leak the socket. The counterpart to addNode for the
   * rebalancing demo and for graceful degradation when a node is decommissioned.
   */
  async removeNode(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Cache node "${id}" does not exist`);
    }
    this.ring.removeNode(id);
    this.nodes.delete(id);
    await node.close(); // close after de-registering so no new request can route to it mid-teardown.
  }

  /**
   * Ping every node. Used by `/metrics` and `/cache/debug` to show which cache nodes are live,
   * and by the rebalancing demo. Runs probes in parallel since they're independent.
   */
  async health(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      [...this.nodes.entries()].map(async ([id, node]) => [id, await node.ping()] as const),
    );
    return Object.fromEntries(entries);
  }

  /**
   * Per-node key-share distribution, for /metrics and the "virtual nodes give an even spread" demo.
   *
   * ring.stats() counts only the keys you hand it, so calling it with no sample returns all-zeros.
   * We therefore feed it a representative population of prefix keys: the caller's sample if given,
   * otherwise a generated sweep of 1- and 2-character prefixes (a–z, a–z×a–z) namespaced exactly as
   * real keys are. That mirrors how prefixes actually route, so the reported distribution is the
   * real one the cache experiences — the evidence the perf report needs.
   */
  ringStats(sampleKeys?: string[]): ReturnType<ConsistentHashRing["stats"]> {
    const sample = sampleKeys && sampleKeys.length > 0 ? sampleKeys : this.defaultPrefixSample();
    return this.ring.stats(sample);
  }

  /** Generate a representative set of namespaced prefix keys (a–z and aa–zz) for distribution stats. */
  private defaultPrefixSample(): string[] {
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const keys: string[] = [];
    for (const a of letters) {
      keys.push(this.cacheKey(a));
      for (const b of letters) keys.push(this.cacheKey(a + b));
    }
    return keys; // 26 + 676 = 702 representative prefix keys.
  }

  /** Close all node connections on shutdown so the process exits cleanly without leaked sockets. */
  async close(): Promise<void> {
    await Promise.all([...this.nodes.values()].map((node) => node.close()));
  }
}
