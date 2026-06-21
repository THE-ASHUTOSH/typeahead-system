/**
 * Unit tests for the Trie and the basic ranking helper.
 *
 * These run WITHOUT Express, Docker, Redis, or Postgres — the trie is pure logic, which is exactly
 * why we tested it in isolation (a viva point: pure modules are independently verifiable). The most
 * important test is the last one: it proves the per-node top-K cache returns the SAME answer as a
 * brute-force scan, i.e. the latency optimisation did not change correctness.
 */

import { describe, it, expect, vi } from "vitest";
import { Trie, type Suggestion } from "../src/trie/Trie.js";
import { rankByCount } from "../src/ranking/basic.js";

/** Small, explicit fixture so expectations are easy to read and defend. */
function buildSampleTrie(topK = 10): Trie {
  const t = new Trie(topK);
  // Counts chosen so ordering is unambiguous and prefixes overlap ("ip..." family).
  t.insert("iphone", 100000);
  t.insert("iphone 15", 85000);
  t.insert("iphone charger", 60000);
  t.insert("ipad", 70000);
  t.insert("java tutorial", 40000);
  t.insert("javascript", 95000);
  return t;
}

describe("Trie.searchPrefix", () => {
  it("returns only queries that start with the prefix", () => {
    const t = buildSampleTrie();
    const results = t.searchPrefix("iphone", 10).map((s) => s.query);
    expect(results).toEqual(["iphone", "iphone 15", "iphone charger"]);
    // None of the non-matching queries leak in.
    expect(results).not.toContain("ipad");
    expect(results).not.toContain("javascript");
  });

  it("is case-insensitive on the prefix (mixed-case input must work)", () => {
    const t = buildSampleTrie();
    const lower = t.searchPrefix("iph", 10).map((s) => s.query);
    const upper = t.searchPrefix("IPH", 10).map((s) => s.query);
    const mixed = t.searchPrefix("  IpHoNe  ", 10).map((s) => s.query); // also exercises trim().
    expect(lower).toEqual(["iphone", "iphone 15", "iphone charger"]);
    expect(upper).toEqual(lower);
    expect(mixed).toEqual(["iphone", "iphone 15", "iphone charger"]);
  });

  it("is case-insensitive on insert too (queries stored normalized)", () => {
    const t = new Trie(10);
    t.insert("IPhone", 100000);
    t.insert("iPHONE 15", 85000);
    expect(t.searchPrefix("iphone", 10).map((s) => s.query)).toEqual([
      "iphone",
      "iphone 15",
    ]);
  });

  it("sorts matches by count in descending order", () => {
    const t = buildSampleTrie();
    const ip = t.searchPrefix("ip", 10);
    // Expected order by count DESC: iphone 100k, iphone 15 85k, ipad 70k, iphone charger 60k.
    expect(ip.map((s) => s.count)).toEqual([100000, 85000, 70000, 60000]);
    expect(ip.map((s) => s.query)).toEqual([
      "iphone",
      "iphone 15",
      "ipad",
      "iphone charger",
    ]);
  });

  it("returns at most `limit` suggestions (spec cap of 10)", () => {
    const t = new Trie(10);
    // Insert 25 queries sharing the prefix "q", counts 25..1 so order is predictable.
    for (let i = 0; i < 25; i++) t.insert(`q${i}`, 25 - i);
    const results = t.searchPrefix("q", 10);
    expect(results).toHaveLength(10);
    // The ten returned must be the ten highest counts (25 down to 16).
    expect(results.map((s) => s.count)).toEqual([
      25, 24, 23, 22, 21, 20, 19, 18, 17, 16,
    ]);
  });

  it("returns [] for empty / whitespace-only prefix (chosen behavior)", () => {
    const t = buildSampleTrie();
    expect(t.searchPrefix("", 10)).toEqual([]);
    expect(t.searchPrefix("   ", 10)).toEqual([]);
  });

  it("returns [] for a prefix with no matches", () => {
    const t = buildSampleTrie();
    expect(t.searchPrefix("zzz", 10)).toEqual([]);
    expect(t.searchPrefix("iphones extra", 10)).toEqual([]); // walks off the end of the trie.
  });

  it("returns [] for missing / undefined / null input", () => {
    const t = buildSampleTrie();
    expect(t.searchPrefix(undefined, 10)).toEqual([]);
    expect(t.searchPrefix(null, 10)).toEqual([]);
  });

  it("does not let callers mutate the internal cache", () => {
    const t = buildSampleTrie();
    const first = t.searchPrefix("ip", 10);
    first.pop(); // mutate the returned array.
    // A fresh call is unaffected -> we returned a copy, not the internal list.
    expect(t.searchPrefix("ip", 10).length).toBe(4);
  });

  it("is build-once: rejects a duplicate insert (keeps the first count, no duplicate entry)", () => {
    // The trie is immutable after build; counts are refreshed by REBUILDING from the DB, not by
    // re-inserting. A second insert of the same query is a no-op (warns) — this is what prevents
    // the bounded-top-K corruption bug where a count DECREASE could never restore an evicted sibling.
    const t = new Trie(10);
    t.insert("iphone", 100);
    t.insert("iphone", 999); // duplicate — must be ignored, NOT applied as an update.
    const r = t.searchPrefix("iph", 10);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual<Suggestion>({ query: "iphone", count: 100 }); // first count kept.
    expect(t.wordCount()).toBe(1); // no phantom second word.
  });

  it("never corrupts top-K under capacity pressure (the bug the build-once contract prevents)", () => {
    // Regression guard for the count-decrease/eviction bug: with K=2, inserting qa=100,qb=90,qc=80
    // evicts qc. Under the OLD 'update wins' code, then inserting qa=10 would demote qa but could
    // not restore qc, yielding the wrong [qb,qa10]. Build-once rejects the qa re-insert, so the
    // answer stays the correct top-2 [qb90, qc80] (qc is present because qa wasn't re-inserted).
    const t = new Trie(2);
    t.insert("qa", 100);
    t.insert("qb", 90);
    t.insert("qc", 80); // qc evicted from node 'q' top-2 ([qa,qb]).
    t.insert("qa", 10); // duplicate -> ignored.
    const r = t.searchPrefix("q", 2);
    expect(r).toEqual<Suggestion[]>([
      { query: "qa", count: 100 },
      { query: "qb", count: 90 },
    ]);
  });

  it("warns and truncates (does not silently return wrong results) when limit exceeds capacity", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = new Trie(2); // capacity 2.
    t.insert("aa", 3);
    t.insert("ab", 2);
    t.insert("ac", 1);
    const r = t.searchPrefix("a", 5); // ask for more than capacity.
    expect(r).toHaveLength(2); // truncated to capacity, not a wrong top-5.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("ignores null / undefined / blank queries on insert", () => {
    const t = new Trie(10);
    t.insert(null, 5);
    t.insert(undefined, 5);
    t.insert("   ", 5);
    expect(t.wordCount()).toBe(0);
  });
});

describe("Trie diagnostics", () => {
  it("counts distinct words", () => {
    const t = buildSampleTrie();
    expect(t.wordCount()).toBe(6);
  });

  it("reports a node count of at least the root", () => {
    const t = new Trie(10);
    expect(t.size()).toBeGreaterThanOrEqual(1);
    t.insert("ab", 1);
    // root + 'a' + 'b' = 3 nodes.
    expect(t.size()).toBe(3);
  });
});

describe("rankByCount (basic ranking helper)", () => {
  it("sorts by count desc and caps to limit", () => {
    const input: Suggestion[] = [
      { query: "b", count: 2 },
      { query: "a", count: 5 },
      { query: "c", count: 1 },
    ];
    expect(rankByCount(input, 2)).toEqual([
      { query: "a", count: 5 },
      { query: "b", count: 2 },
    ]);
  });

  it("is stable for equal counts (preserves input order)", () => {
    const input: Suggestion[] = [
      { query: "first", count: 10 },
      { query: "second", count: 10 },
      { query: "third", count: 10 },
    ];
    expect(rankByCount(input, 10).map((s) => s.query)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("does not mutate its input array", () => {
    const input: Suggestion[] = [
      { query: "a", count: 1 },
      { query: "b", count: 2 },
    ];
    rankByCount(input, 10);
    expect(input.map((s) => s.query)).toEqual(["a", "b"]); // original order intact.
  });
});

/**
 * THE CORRECTNESS-OF-OPTIMISATION TEST.
 * Build a randomized trie, then for every prefix compare the trie's top-K cached answer against a
 * brute-force "scan all queries, filter by prefix, sort by count, take K" oracle. If they ever
 * disagree, the per-node cache is buggy. They must agree for the optimisation to be trustworthy.
 */
describe("top-K cache equals a naive full scan", () => {
  /** Deterministic naive oracle: no trie, just filter + sort the raw dataset. */
  function naive(
    data: Suggestion[],
    prefix: string,
    limit: number,
  ): Suggestion[] {
    const p = prefix.trim().toLowerCase();
    return data
      .filter((d) => d.query.toLowerCase().startsWith(p))
      .sort((a, b) => b.count - a.count) // stable sort, same as the ranking helper.
      .slice(0, limit)
      .map((d) => ({ query: d.query.toLowerCase(), count: d.count }));
  }

  /** Run the trie-vs-oracle comparison over every short prefix for a given dataset and K. */
  function assertMatchesOracle(data: Suggestion[], words: string[], K: number): void {
    const t = new Trie(K);
    for (const d of data) t.insert(d.query, d.count);

    const prefixes = new Set<string>(["zz"]); // include a guaranteed no-match.
    for (const w of words) {
      for (let len = 1; len <= w.length; len++) prefixes.add(w.slice(0, len));
    }

    for (const prefix of prefixes) {
      // Note: we do NOT compare the empty prefix here — its behaviour ([] by design) is asserted
      // separately above; the oracle's empty-prefix semantics are intentionally not the trie's.
      const fromTrie = t.searchPrefix(prefix, K);
      const fromNaive = naive(data, prefix, K);
      expect(fromTrie, `prefix="${prefix}"`).toEqual(fromNaive);
    }
  }

  it("matches the oracle across many prefixes (distinct counts)", () => {
    const K = 10;
    const words = [
      "apple", "app", "application", "apply", "apricot",
      "banana", "band", "bandana", "bandwidth", "bank",
      "cat", "catalog", "category", "cater", "caterpillar",
      "dog", "dodge", "doge", "dot", "dote",
    ];
    const data: Suggestion[] = words.map((w, i) => ({
      query: w,
      count: (i + 1) * 1000 + i, // all-distinct, monotonic counts.
    }));
    assertMatchesOracle(data, words, K);
  });

  it("matches the oracle with TIED counts forcing eviction (K < number of completions)", () => {
    // The case most likely to expose a divergence between the incremental top-K cache and a stable
    // sort: many entries share a count under the same prefix, and there are MORE of them than K, so
    // eviction happens. Both the trie's incremental splice and the oracle's stable sort must keep
    // insertion order among equal counts, so the answers must still agree exactly.
    const K = 3;
    const words = ["aa", "ab", "ac", "ad", "ae", "af", "ag"]; // 7 completions of "a", cap is 3.
    const data: Suggestion[] = [
      { query: "aa", count: 50 },
      { query: "ab", count: 50 }, // tie with aa
      { query: "ac", count: 50 }, // tie
      { query: "ad", count: 50 }, // tie — must be EVICTED (insertion order: aa,ab,ac kept)
      { query: "ae", count: 90 }, // higher, jumps to front
      { query: "af", count: 10 }, // lower, dropped
      { query: "ag", count: 90 }, // ties the top with ae, inserted after -> ranks just below ae
    ];
    assertMatchesOracle(data, words, K);
  });
});
