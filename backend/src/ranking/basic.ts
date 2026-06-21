/**
 * Basic ranking — the 60%-marks "sort by overall count" path.
 *
 * This is deliberately tiny and pure (no Express / DB / Redis). It exists as its own module so the
 * read path has ONE named place that defines "basic ranking", separate from the recency-aware
 * ranking added later. Swapping `rankByCount` for the recency ranker is then a one-line change at
 * the call site, and the viva can point at the exact difference between the two ranking strategies.
 *
 * NOTE: the Trie's per-node top-K already returns results sorted by count, so in the normal flow
 * this is effectively a defensive re-sort + cap. We still apply it explicitly because suggestions
 * can arrive from other sources (e.g. a cache payload, or a DB fallback) where order isn't
 * guaranteed, and the API contract ("at most `limit`, count DESC") must hold regardless of source.
 */

import { config } from "../config.js";
import type { Suggestion } from "../trie/Trie.js";

/**
 * Sort suggestions by count descending (STABLE for ties) and cap to `limit`.
 *
 * - Stability: when two queries have the same count we preserve their incoming order rather than
 *   shuffling them, so results are deterministic across calls (important for cache reproducibility
 *   and for tests). We achieve stability by comparing by count only and relying on the fact that
 *   Array.prototype.sort is guaranteed stable in modern JS (ES2019+), which our ES2022 target uses.
 * - We copy the input (spread) before sorting so we never mutate the caller's array — the trie's
 *   internal top-K cache, for instance, must not be reordered by a ranking call.
 */
export function rankByCount(
  suggestions: Suggestion[],
  limit: number = config.suggestLimit,
): Suggestion[] {
  return [...suggestions]
    .sort((a, b) => b.count - a.count) // count DESC; equal counts keep their original order (stable).
    .slice(0, Math.max(0, limit)); // never return more than the cap; guard against negative limits.
}
