/**
 * index.ts — the server bootstrap.
 *
 * Responsibilities, in order:
 *   1. Open the primary store (Postgres) and verify connectivity.
 *   2. Open the distributed cache (eager-connect all Redis nodes).
 *   3. Wire the BatchWriter: durable upsert + cache invalidation on flush, so new counts
 *      are reflected in suggestions (spec §4.2). No in-memory index to rebuild — the next
 *      cache miss reads fresh counts straight from Postgres via store.searchPrefix.
 *   4. Build the Express app (deps injected) and start listening.
 *   5. Install SIGINT/SIGTERM handlers for a clean shutdown that does NOT drop the last batch.
 *
 * This is the ONLY file that knows the concrete lifecycle (init/connect/close) of the
 * real infra. app.ts only routes; the core modules only do their one job. Keeping the
 * wiring here is what makes everything else unit-testable without Docker.
 */

import { config } from "./config.js";
import { QueryStore } from "./store/QueryStore.js";
import { CacheService } from "./cache/CacheService.js";
import { BatchWriter, type AggregatedDelta } from "./batch/BatchWriter.js";
import { buildApp, makeModeKey } from "./app.js";

async function main(): Promise<void> {
  // --- 1. Primary store ----------------------------------------------------------
  const store = new QueryStore();
  await store.init(); // MUST be awaited before any query; creates schema + verifies connectivity.
  console.log("[boot] Postgres connected, schema ensured");

  // --- 2. Distributed cache ------------------------------------------------------
  const cache = new CacheService();
  await cache.init(); // eager-connect all Redis nodes so the first read is a real hit/miss.

  // --- 3. Wire the BatchWriter ---------------------------------------------------
  const batchWriter = new BatchWriter(
    // onFlush: the durable write. store.upsertCounts does BOTH the queries upsert AND the
    // search_events insert in two statements total. Once it returns, the new counts are in
    // Postgres, so the very next cache miss for an affected prefix reads them via the SQL
    // prefix search — there is no in-memory index to rebuild.
    async (aggregated: AggregatedDelta[]): Promise<void> => {
      await store.upsertCounts(aggregated);
    },
    // onInvalidate: clear the cached suggestion lists affected by this flush.
    //
    // SIMPLIFICATION (explain in viva): IDEALLY we would invalidate every PREFIX of every
    // flushed query (searching "iphone" changes the cached top-10 for "i", "ip", "iph", ...,
    // "iphone", because that query may now enter/leave each of those prefixes' results). Doing
    // that fully is a prefix-fan-out per query. Here we invalidate the EXACT query's own key
    // (both the basic- and recency-mode keys). We accept this simplification because the short
    // cache TTL (config.cacheTtlSeconds, 60s) is the safety net: any prefix we did NOT explicitly
    // invalidate self-heals within one TTL, so rankings are eventually correct. The trade-off is
    // up to ~TTL of staleness on the un-invalidated ancestor prefixes, acceptable for a typeahead.
    async (queries: string[]): Promise<void> => {
      // Reuse makeModeKey() (the SAME helper /suggest uses) so the invalidation key is
      // guaranteed identical to the cached key — building the string by hand would risk drift.
      await Promise.all(
        queries.flatMap((q) => [
          cache.invalidate(makeModeKey("basic", q)),
          cache.invalidate(makeModeKey("recency", q)),
        ]),
      );
    },
  );
  batchWriter.start(); // begin the periodic flush timer (every config.batchFlushMs).

  // --- 4. Build and start the app ------------------------------------------------
  const app = buildApp({
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

  // --- 5. Graceful shutdown ------------------------------------------------------
  // On SIGINT (Ctrl-C) / SIGTERM (docker stop) we must FLUSH THE TAIL before exiting:
  // batchWriter.stop() flushes whatever is still buffered, so we don't lose the last
  // (un-flushed) batch of search submissions. Then we close Redis and Postgres so the
  // process exits without leaking sockets/connections. Guarded so a double signal can't
  // run shutdown twice.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received — flushing tail batch and closing connections...`);
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
