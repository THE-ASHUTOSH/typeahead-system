/**
 * Unit tests for the recency-aware ranking (the "Trending Searches" 20%).
 *
 * The headline test is the DEMOABLE DIFFERENCE the spec asks for: on the SAME
 * sample data, a query with high recent activity but a lower all-time count must
 * outrank a high-all-time-but-now-stale query under the ENHANCED (recency)
 * ranking, while the BASIC (all-time-only) ranking keeps the stale query on top.
 * We import the real basic ranker (../src/ranking/basic.ts) so the contrast uses
 * production code, not a re-implementation.
 *
 * These tests run with NO Express / Redis / Postgres — the ranking modules are
 * pure logic, which is the whole point of keeping them separate.
 */

import { describe, it, expect } from "vitest";

import {
  rankRecencyAware,
  explainScore,
  score,
  type RecencyCandidate,
} from "../src/ranking/recency.js";
import { rankByCount, type CountedQuery } from "../src/ranking/basic.js";
import { config } from "../src/config.js";

/**
 * Map a recency candidate to the basic ranker's input shape: the basic ranking
 * only knows about all-time popularity, so `count` IS the all-time count. This is
 * exactly how the read path feeds the two rankers from the same candidates, so
 * comparing their outputs is a faithful basic-vs-enhanced comparison.
 */
function asBasicSuggestion(c: RecencyCandidate): CountedQuery {
  return { query: c.query, count: c.allTimeCount };
}

describe("recency ranking — basic vs enhanced (the demoable difference)", () => {
  it("surfaces a query spiking now over a stale all-time leader, but only under recency ranking", () => {
    // "classic-hit": historically huge (100k lifetime) but cold right now (no recent searches).
    // "breaking-news": tiny lifetime count (500) but exploding in the last hour/day.
    // The spike is sized so that, under the DEFAULT weights, recency genuinely wins.
    const candidates: RecencyCandidate[] = [
      { query: "classic-hit", allTimeCount: 100_000, count1h: 0, count24h: 0 },
      { query: "breaking-news", allTimeCount: 500, count1h: 40_000, count24h: 40_000 },
    ];

    // BASIC ranking sorts by all-time count only -> the cold classic stays on top.
    const basic = rankByCount(candidates.map(asBasicSuggestion));
    expect(basic[0].query).toBe("classic-hit");
    expect(basic[1].query).toBe("breaking-news");

    // ENHANCED ranking blends the windows -> the query spiking now jumps to the top.
    // This flip is the exact behaviour the spec wants demonstrated.
    const enhanced = rankRecencyAware(candidates);
    expect(enhanced[0].query).toBe("breaking-news");
    expect(enhanced[1].query).toBe("classic-hit");

    // Sanity-check that the scores actually justify the flip under the configured
    // weights (W_1H=3, W_24H=1.5, W_ALLTIME=1 by default):
    //   breaking-news = 3*40_000 + 1.5*40_000 + 1*500    = 180_500
    //   classic-hit   = 3*0      + 1.5*0      + 1*100_000 = 100_000
    // The recency-weighted spike (180.5k) overcomes the all-time leader (100k), which
    // is exactly why the enhanced ranking flips the order and the basic one does not.
    expect(score(candidates[1])).toBeGreaterThan(score(candidates[0]));
  });

  it("returns a query to its baseline once its spike has aged out of the windows", () => {
    // Same query, two points in time. DURING the spike both window counts are high;
    // AFTER it has aged out (events fell outside 1h and 24h) the windows are 0 and it
    // is ranked by all-time only — i.e. nothing is over-ranked permanently.
    const duringSpike: RecencyCandidate = {
      query: "flash-sale",
      allTimeCount: 1_000,
      count1h: 3_000,
      count24h: 3_000,
    };
    const afterAgedOut: RecencyCandidate = {
      query: "flash-sale",
      allTimeCount: 1_000, // lifetime count is the only thing that persists
      count1h: 0,
      count24h: 0,
    };
    const steadyRival: RecencyCandidate = {
      query: "steady-staple",
      allTimeCount: 2_000,
      count1h: 0,
      count24h: 0,
    };

    // During the spike, flash-sale beats the higher-all-time steady rival.
    const ranked1 = rankRecencyAware([duringSpike, steadyRival]);
    expect(ranked1[0].query).toBe("flash-sale");

    // After the spike has aged out, the steady rival (higher all-time) is back on top.
    const ranked2 = rankRecencyAware([afterAgedOut, steadyRival]);
    expect(ranked2[0].query).toBe("steady-staple");
    expect(ranked2[1].query).toBe("flash-sale");
  });
});

describe("recency ranking — score correctness and weights", () => {
  it("computes score as W_1H*count1h + W_24H*count24h + W_ALLTIME*allTimeCount", () => {
    const c: RecencyCandidate = {
      query: "q",
      allTimeCount: 7,
      count1h: 11,
      count24h: 13,
    };
    const { oneHour, twentyFourHour, allTime } = config.weights;
    const expected = oneHour * 11 + twentyFourHour * 13 + allTime * 7;
    expect(score(c)).toBe(expected);
  });

  it("weights the 1h window more heavily than 24h, and 24h more than all-time", () => {
    // Equal raw counts across all three windows -> the contributions must rank
    // 1h > 24h > all-time, proving the weights (not just the counts) drive ranking.
    const c: RecencyCandidate = { query: "q", allTimeCount: 10, count1h: 10, count24h: 10 };
    const b = explainScore(c);
    expect(b.oneHourContribution).toBeGreaterThan(b.twentyFourHourContribution);
    expect(b.twentyFourHourContribution).toBeGreaterThan(b.allTimeContribution);
  });

  it("explainScore breakdown sums exactly to score()", () => {
    const c: RecencyCandidate = { query: "q", allTimeCount: 3, count1h: 5, count24h: 9 };
    const b = explainScore(c);
    expect(b.oneHourContribution + b.twentyFourHourContribution + b.allTimeContribution).toBe(
      b.total,
    );
    expect(b.total).toBe(score(c));
  });
});

describe("recency ranking — limit cap and ordering", () => {
  it("caps the result to the given limit", () => {
    const candidates: RecencyCandidate[] = Array.from({ length: 25 }, (_, i) => ({
      query: `q${i}`,
      allTimeCount: i,
      count1h: i,
      count24h: i,
    }));
    expect(rankRecencyAware(candidates, 10)).toHaveLength(10);
    expect(rankRecencyAware(candidates, 3)).toHaveLength(3);
  });

  it("defaults the limit to config.suggestLimit", () => {
    const candidates: RecencyCandidate[] = Array.from(
      { length: config.suggestLimit + 5 },
      (_, i) => ({ query: `q${i}`, allTimeCount: i, count1h: 0, count24h: 0 }),
    );
    expect(rankRecencyAware(candidates)).toHaveLength(config.suggestLimit);
  });

  it("returns an empty array for a non-positive limit", () => {
    const candidates: RecencyCandidate[] = [
      { query: "a", allTimeCount: 1, count1h: 1, count24h: 1 },
    ];
    expect(rankRecencyAware(candidates, 0)).toEqual([]);
    expect(rankRecencyAware(candidates, -5)).toEqual([]);
  });

  it("sorts strictly by descending score", () => {
    const candidates: RecencyCandidate[] = [
      { query: "low", allTimeCount: 1, count1h: 0, count24h: 0 },
      { query: "high", allTimeCount: 1, count1h: 100, count24h: 0 },
      { query: "mid", allTimeCount: 1, count1h: 10, count24h: 0 },
    ];
    const ranked = rankRecencyAware(candidates);
    expect(ranked.map((r) => r.query)).toEqual(["high", "mid", "low"]);
    // scores must be monotonically non-increasing
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });
});

describe("recency ranking — deterministic tie-breaks", () => {
  it("breaks score ties by all-time count descending", () => {
    // Construct two candidates with EQUAL total scores but different all-time counts,
    // so only the all-time tie-break can decide the order.
    //   bigger:  3*0  + 1.5*0 + 1*80 = 80
    //   smaller: 3*10 + 1.5*0 + 1*50 = 80   (recent activity compensates for less history)
    // Equal scores -> the higher all-time count ("bigger") must rank first.
    const tied: RecencyCandidate[] = [
      { query: "smaller", allTimeCount: 50, count1h: 10, count24h: 0 },
      { query: "bigger", allTimeCount: 80, count1h: 0, count24h: 0 },
    ];
    expect(score(tied[0])).toBe(score(tied[1]));
    const ranked = rankRecencyAware(tied);
    expect(ranked.map((r) => r.query)).toEqual(["bigger", "smaller"]);
  });

  it("breaks full ties (same score AND same all-time) alphabetically by query", () => {
    const candidates: RecencyCandidate[] = [
      { query: "banana", allTimeCount: 5, count1h: 2, count24h: 1 },
      { query: "apple", allTimeCount: 5, count1h: 2, count24h: 1 },
      { query: "cherry", allTimeCount: 5, count1h: 2, count24h: 1 },
    ];
    const ranked = rankRecencyAware(candidates);
    expect(ranked.map((r) => r.query)).toEqual(["apple", "banana", "cherry"]);
  });

  it("is order-independent: shuffling the input does not change the ranking", () => {
    const candidates: RecencyCandidate[] = [
      { query: "apple", allTimeCount: 5, count1h: 2, count24h: 1 },
      { query: "banana", allTimeCount: 5, count1h: 2, count24h: 1 },
      { query: "cherry", allTimeCount: 5, count1h: 2, count24h: 1 },
    ];
    const a = rankRecencyAware(candidates).map((r) => r.query);
    const b = rankRecencyAware([...candidates].reverse()).map((r) => r.query);
    expect(a).toEqual(b);
  });

  it("does not mutate the caller's input array", () => {
    const candidates: RecencyCandidate[] = [
      { query: "a", allTimeCount: 1, count1h: 0, count24h: 0 },
      { query: "b", allTimeCount: 9, count1h: 0, count24h: 0 },
    ];
    const before = candidates.map((c) => c.query);
    rankRecencyAware(candidates);
    expect(candidates.map((c) => c.query)).toEqual(before);
  });
});
