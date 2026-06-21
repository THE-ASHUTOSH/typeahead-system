/**
 * Shared cache-layer types.
 *
 * WHY a tiny dedicated file: the routes, the trie, and the cache all need to agree
 * on the exact shape of a "suggestion" so the JSON we store in Redis round-trips
 * cleanly. Defining it once here (rather than re-declaring it per module) means the
 * cache never silently disagrees with the producer about what a cached entry holds.
 */

/**
 * One typeahead suggestion: the candidate query plus the numeric score we ranked it by.
 *
 * `query` is the completion text shown in the dropdown. `score` is whatever the active
 * ranking produced (all-time count in the basic version, or the recency-blended score
 * in the enhanced version) — the cache treats it as an opaque number and never recomputes
 * it, so caching is ranking-agnostic.
 */
export interface Suggestion {
  query: string;
  score: number;
}
