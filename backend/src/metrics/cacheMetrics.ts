/**
 * Cache hit/miss counters.
 *
 * WHY this lives in its own module (not inside CacheService): the assignment's
 * non-functional section asks us to *report* cache hit rate, and the `/metrics`
 * route needs to read these numbers without holding a reference to the cache.
 * Keeping the counters as a standalone, importable singleton lets both the cache
 * (which increments) and the metrics route (which reads) share one source of truth,
 * and lets us unit-test the rate math with zero Redis/Express running.
 *
 * It is a module-level singleton because there is exactly one cache layer per
 * process; a class instance would just add ceremony without buying isolation.
 */

/** Total successful cache reads (key found and parsed). */
let hits = 0;
/** Total cache reads that fell through to the trie/DB (key absent, expired, or Redis down). */
let misses = 0;

/** Record one cache hit. Called by CacheService on a successful, parseable read. */
export function recordHit(): void {
  hits += 1;
}

/** Record one cache miss. Called on absent/expired keys AND on Redis-unreachable reads. */
export function recordMiss(): void {
  misses += 1;
}

/** Immutable snapshot of the counters plus the derived hit rate, for `GET /metrics`. */
export interface CacheMetricsSnapshot {
  hits: number;
  misses: number;
  total: number;
  /** hits / total, in [0,1]. Defined as 0 when there have been no reads yet (avoid NaN). */
  hitRate: number;
}

/** Read the current counters. Pure read — never mutates, safe to call from any route. */
export function getCacheMetrics(): CacheMetricsSnapshot {
  const total = hits + misses;
  // Guard the divide-by-zero: before any traffic the "rate" is undefined; we report 0.
  const hitRate = total === 0 ? 0 : hits / total;
  return { hits, misses, total, hitRate };
}

/**
 * Reset counters to zero. Primarily for tests and for the bench script, which wants a
 * clean baseline before a measured load run so the reported hit rate reflects only that run.
 */
export function resetCacheMetrics(): void {
  hits = 0;
  misses = 0;
}
