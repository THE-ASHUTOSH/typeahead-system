/**
 * index.ts — the server bootstrap.
 *
 * Responsibilities, in order:
 *   1. Open the primary store (Postgres) and verify connectivity.
 *   2. Build the in-memory Trie ONCE by streaming all (query,count) rows from the store.
 *   3. Open the distributed cache (eager-connect all Redis nodes).
 *   4. Wire the BatchWriter: durable upsert + cache invalidation + a DEBOUNCED trie rebuild
 *      on flush, so new counts are eventually reflected in suggestions (spec §4.2).
 *   5. Build the Express app (deps injected) and start listening.
 *   6. Install SIGINT/SIGTERM handlers for a clean shutdown that does NOT drop the last batch.
 *
 * This is the ONLY file that knows the concrete lifecycle (init/connect/close) of the
 * real infra. app.ts only routes; the core modules only do their one job. Keeping the
 * wiring here is what makes everything else unit-testable without Docker.
 */

import { config } from "./config.js";
import { Trie } from "./trie/Trie.js";
import { QueryStore } from "./store/QueryStore.js";
import { CacheService } from "./cache/CacheService.js";
import { BatchWriter, type AggregatedDelta } from "./batch/BatchWriter.js";
import { buildApp, makeModeKey } from "./app.js";

/**
 * Build a fresh Trie from the authoritative counts in Postgres.
 *
 * BUILD-ONCE CONTRACT (see Trie.ts): the trie never mutates in place; to reflect changed
 * counts we throw the old one away and build a NEW instance from the DB. loadAll() streams
 * the ~150k rows in pages so we never hold the full result set and the growing trie in
 * memory at the same time. Returns the freshly-built trie for the caller to swap in.
 */
async function buildTrie(store: QueryStore): Promise<Trie> {
  const trie = new Trie(); // topKCapacity defaults to config.suggestLimit (10)
  for await (const batch of store.loadAll()) {
    for (const row of batch) {
      // insert is build-once; each distinct query is inserted exactly once per build.
      trie.insert(row.query, row.count);
    }
  }
  return trie;
}

async function main(): Promise<void> {
  // --- 1. Primary store ----------------------------------------------------------
  const store = new QueryStore();
  await store.init(); // MUST be awaited before any query; creates schema + verifies connectivity.

  // --- 2. Build the trie once at boot --------------------------------------------
  // We keep the trie in a mutable holder so a later rebuild can swap in a new instance
  // while the routes (which read via a getter) transparently pick it up.
  let trie = await buildTrie(store);
  console.log(`[boot] trie built: ${trie.wordCount()} queries, ${trie.size()} nodes`);

  // --- 3. Distributed cache ------------------------------------------------------
  const cache = new CacheService();
  await cache.init(); // eager-connect all Redis nodes so the first read is a real hit/miss.

  // --- 4. Wire the BatchWriter ---------------------------------------------------
  // DEBOUNCED-WITH-MAX-WAIT trie rebuild. Rebuilding the whole trie is O(dataset), so we don't
  // want to do it on every flush (flushes happen every ~2s under load). A naive debounce —
  // "rebuild once flushes go quiet" — has a starvation bug: under SUSTAINED traffic a flush
  // always arrives before the quiet window elapses, the timer is perpetually reset, and the trie
  // NEVER rebuilds, so /suggest serves stale counts indefinitely (violating spec §4.2). To fix
  // that we combine two bounds:
  //   * debounce  (rebuildDebounceMs): rebuild after flushes go quiet — coalesces bursts.
  //   * max-wait  (rebuildMaxWaitMs):  rebuild AT THE LATEST this long after the FIRST flush
  //                                    since the last rebuild — guarantees a refresh under load.
  // Whichever fires first wins. So the trie refreshes within a bounded interval regardless of how
  // busy the system is. The short cache TTL bounds staleness between rebuilds; invalidation drops
  // touched prefixes immediately.
  const rebuildDebounceMs = config.batchFlushMs; // quiet window: one flush cadence.
  const rebuildMaxWaitMs = config.batchFlushMs * 5; // hard cap (~10s) from the first pending flush.
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let rebuilding = false;
  let firstPendingFlushAt: number | undefined; // when the oldest un-rebuilt flush arrived.
  // Declared here (before scheduleTrieRebuild references it) so the tail flush during shutdown
  // cannot arm a new rebuild after we've started tearing down. Set true in shutdown().
  let shuttingDown = false;

  function runTrieRebuild(): void {
    rebuildTimer = undefined;
    firstPendingFlushAt = undefined; // this rebuild covers everything flushed so far.
    if (rebuilding) return; // a rebuild is already running; a later flush will re-arm.
    rebuilding = true;
    void buildTrie(store)
      .then((fresh) => {
        trie = fresh; // atomic swap: the getter now returns the new trie with fresh counts.
        console.log(`[rebuild] trie refreshed: ${trie.wordCount()} queries`);
      })
      .catch((err) => {
        // A failed rebuild is non-fatal: the old trie keeps serving (slightly stale) results.
        console.error("[rebuild] trie rebuild failed, keeping previous trie:", err);
      })
      .finally(() => {
        rebuilding = false;
      });
  }

  function scheduleTrieRebuild(): void {
    if (shuttingDown) return; // don't arm a new rebuild while tearing down (see shutdown()).
    const now = Date.now();
    if (firstPendingFlushAt === undefined) firstPendingFlushAt = now;

    // If we've already waited the max-wait since the first pending flush, rebuild NOW rather than
    // resetting the debounce again — this is what prevents starvation under sustained load.
    if (now - firstPendingFlushAt >= rebuildMaxWaitMs) {
      if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
      runTrieRebuild();
      return;
    }

    // Otherwise (re)arm the debounce: rebuild once flushes go quiet for rebuildDebounceMs.
    if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(runTrieRebuild, rebuildDebounceMs);
    // Don't keep the event loop alive just for this timer.
    if (typeof rebuildTimer.unref === "function") rebuildTimer.unref();
  }

  const batchWriter = new BatchWriter(
    // onFlush: the durable write. store.upsertCounts does BOTH the queries upsert AND the
    // search_events insert in two statements total. After a successful durable write we
    // schedule the (debounced) trie rebuild so suggestions eventually reflect the new counts.
    async (aggregated: AggregatedDelta[]): Promise<void> => {
      await store.upsertCounts(aggregated);
      scheduleTrieRebuild();
    },
    // onInvalidate: clear the cached suggestion lists affected by this flush.
    //
    // SIMPLIFICATION (explain in viva): IDEALLY we would invalidate every PREFIX of every
    // flushed query (searching "iphone" changes the cached top-K for "i", "ip", "iph", ...,
    // "iphone", because that query may now enter/leave each of those prefixes' top-10). Doing
    // that fully is a prefix-fan-out per query. Here we invalidate the EXACT query's own key
    // (and, in recency mode, its "r:" namespaced key). We accept this simplification because
    // the short cache TTL (config.cacheTtlSeconds, 60s) is the safety net: any prefix we did
    // NOT explicitly invalidate self-heals within one TTL, so rankings are eventually correct.
    // The trade-off is up to ~TTL of staleness on the un-invalidated ancestor prefixes, which
    // is acceptable for a typeahead. (To go further: derive all prefixes of each query and
    // invalidate each — straightforward but more cache traffic per flush.)
    async (queries: string[]): Promise<void> => {
      // Invalidate BOTH mode-namespaced keys for each flushed query. We reuse makeModeKey()
      // (the SAME helper /suggest uses to build its keys) so the invalidation key is guaranteed
      // identical to the cached key — building the string by hand here would risk drift.
      await Promise.all(
        queries.flatMap((q) => [
          cache.invalidate(makeModeKey("basic", q)),
          cache.invalidate(makeModeKey("recency", q)),
        ]),
      );
    },
  );
  batchWriter.start(); // begin the periodic flush timer (every config.batchFlushMs).

  // --- 5. Build and start the app ------------------------------------------------
  const app = buildApp({
    getTrie: () => trie, // getter so post-rebuild swaps are picked up live.
    cache,
    batchWriter,
    store,
    // defaultMode omitted → app defaults to "basic" (the 60% path).
  });

  const server = app.listen(config.port, () => {
    // Clear startup banner with the URLs the demo needs.
    console.log("");
    console.log("  Search Typeahead API is up");
    console.log(`  ├─ API base      http://localhost:${config.port}`);
    console.log(`  ├─ Suggest       http://localhost:${config.port}/suggest?q=ip`);
    console.log(`  ├─ Trending      http://localhost:${config.port}/trending`);
    console.log(`  ├─ Cache debug   http://localhost:${config.port}/cache/debug?prefix=ip`);
    console.log(`  ├─ Metrics       http://localhost:${config.port}/metrics`);
    console.log(`  └─ UI (Vite dev) http://localhost:5173`);
    console.log("");
  });

  // --- 6. Graceful shutdown ------------------------------------------------------
  // On SIGINT (Ctrl-C) / SIGTERM (docker stop) we must FLUSH THE TAIL before exiting:
  // batchWriter.stop() flushes whatever is still buffered, so we don't lose the last
  // (un-flushed) batch of search submissions. Then we close Redis and Postgres so the
  // process exits without leaking sockets/connections. Guarded so a double signal can't
  // run shutdown twice.
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received — flushing tail batch and closing connections...`);
    if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
    // Stop accepting new HTTP connections first.
    server.close();
    try {
      await batchWriter.stop(); // flush the last batch (don't lose it).
      await cache.close(); // close all Redis sockets.
      await store.close(); // close the Postgres pool.
      console.log("[shutdown] clean. bye.");
      process.exit(0);
    } catch (err) {
      console.error("[shutdown] error during shutdown:", err);
      process.exit(1);
    }
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Top-level: surface any boot failure loudly and exit non-zero so `npm run dev` shows it.
main().catch((err) => {
  console.error("[boot] fatal error during startup:", err);
  process.exit(1);
});
