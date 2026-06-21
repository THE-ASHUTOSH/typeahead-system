/**
 * generate-dataset.ts — produces data/queries.csv for the typeahead system.
 *
 * Run via:  npm run dataset   (cwd is backend/, see backend/package.json)
 *
 * WHAT it does
 * ------------
 * Writes a CSV with header "query,count" and AT LEAST 150,000 DISTINCT realistic
 * search queries whose counts follow a Zipfian (power-law) distribution.
 *
 * WHY Zipf (this is a viva talking-point)
 * ---------------------------------------
 * Real search/query popularity is a power law: a handful of queries are searched
 * enormously often and there is a very long tail of rare ones. Modelling that with
 * Zipf (count ~ BASE / rank^s) makes the rest of the system *meaningful*:
 *   - "sorted by count" actually separates head from tail (not a flat list),
 *   - the cache hit-rate is realistic — a few hot prefixes serve most traffic,
 *   - the trie's per-node top-K has real winners to keep.
 * With s ≈ 1.0 the rank-1 query is ~10x the rank-10 query, ~100x the rank-100, etc.,
 * which mirrors observed query logs.
 *
 * WHY a seeded PRNG (reproducibility)
 * -----------------------------------
 * A dataset *should* look varied, but for the report/demo we want re-running the
 * generator to produce the SAME file (so latency/hit-rate numbers are comparable
 * across runs and a grader can reproduce them). We therefore use a tiny seeded
 * xorshift32 PRNG implemented inline instead of Math.random (which is unseeded and
 * would change every run). Change SEED to get a different — but still reproducible —
 * dataset.
 *
 * Dependency-free on purpose: only node:fs / node:path so it runs under tsx with no
 * install step. ESM project, so any relative import would need a .js extension — we
 * need none here.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Knobs. Kept as named constants (no magic numbers buried in logic) so each one
// is explainable. These are dataset-generation parameters, not runtime config,
// so they live here rather than in backend/src/config.ts.
// ---------------------------------------------------------------------------

/** Seed for the PRNG. Fixed => reproducible dataset. Any non-zero 32-bit int works. */
const SEED = 1_234_567;

/** Minimum DISTINCT rows the spec demands; we generate strictly more than this. */
const TARGET_ROWS = 150_000;

/**
 * Zipf exponent. s = 1.0 is the classic Zipf law (the value observed in real text /
 * query logs). Larger s => steeper head; smaller => flatter. We keep it at 1.0.
 */
const ZIPF_EXPONENT = 1.0;

/**
 * BASE = the (pre-jitter) count assigned to the rank-1 query. With count = BASE/rank^1,
 * rank 1 ≈ 100000, rank 1000 ≈ 100, rank 100000 ≈ 1 — a ~1..100000 span, matching the
 * spec's example table (iphone=100000 ... long tail). 100000 also keeps counts inside a
 * BIGINT comfortably.
 */
const BASE = 100_000;

/** Floor so the long tail never drops below a real search (count >= 1, never 0). */
const MIN_COUNT = 1;

/**
 * Multiplicative jitter range applied to each Zipf count: count *= U(1-J, 1+J).
 * WHY jitter: a pure BASE/rank^s curve is perfectly smooth and unrealistic; real counts
 * wobble around the trend. 0.15 (±15%) adds realism without disturbing the head/tail
 * ordering meaningfully. Seeded, so still reproducible.
 */
const JITTER = 0.15;

/** Output path: <repo>/data/queries.csv (this file lives in <repo>/scripts/). */
const OUTPUT_PATH = resolve(import.meta.dirname, "..", "data", "queries.csv");

// ---------------------------------------------------------------------------
// Seeded PRNG: xorshift32. Tiny, fast, deterministic. Returns a float in [0, 1).
// We implement it inline rather than pulling a dependency so every line is ours
// and explainable. xorshift mutates a 32-bit state with shift/XOR steps; we then
// map the unsigned state into [0,1) by dividing by 2^32.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  // State must be non-zero for xorshift; coerce to a non-zero 32-bit int.
  let state = seed >>> 0 || 1;
  return () => {
    // Classic xorshift32 sequence (shifts 13, 17, 5).
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // `>>> 0` reinterprets as unsigned; divide by 2^32 to land in [0, 1).
    return (state >>> 0) / 0x1_0000_0000;
  };
}

// ---------------------------------------------------------------------------
// Vocabularies. The whole point is OVERLAPPING PREFIXES: many "iphone..." rows,
// many "java...", "python..." rows, etc., so the typeahead demo is compelling
// (type "iph" and watch 10 strong suggestions appear). We build queries by
// combining a head term with optional modifiers; the combinatorics easily exceed
// 150k distinct strings, and we dedupe to guarantee distinctness.
// ---------------------------------------------------------------------------

/** Popular brand/product heads — chosen so several share prefixes (samsung galaxy / samsung tv). */
const BRANDS: string[] = [
  "iphone", "iphone 15", "iphone 15 pro", "iphone 15 pro max", "iphone 14",
  "samsung galaxy", "samsung galaxy s24", "samsung tv", "samsung watch",
  "macbook", "macbook air", "macbook pro", "ipad", "ipad pro", "apple watch",
  "airpods", "airpods pro", "nike shoes", "nike air force 1", "nike air max",
  "adidas", "adidas samba", "puma", "sony headphones", "sony tv", "bose",
  "dell laptop", "hp laptop", "lenovo thinkpad", "asus rog", "google pixel",
  "pixel 8", "oneplus", "xiaomi", "realme", "boat earbuds", "jbl speaker",
  "playstation 5", "xbox series x", "nintendo switch", "kindle", "fitbit",
  "canon camera", "gopro", "dyson vacuum", "instant pot", "air fryer",
  "office chair", "standing desk", "mechanical keyboard", "gaming mouse",
  "monitor", "4k monitor", "ssd", "graphics card", "rtx 4090", "router",
];

/** Programming / tech learning heads — heavy prefix overlap (java*, python*, react*). */
const TECH: string[] = [
  "java", "java tutorial", "java interview questions", "java streams",
  "python", "python tutorial", "python list comprehension", "python pandas",
  "python decorators", "javascript", "javascript closures", "typescript",
  "react", "react hooks", "react router", "react query", "redux",
  "node js", "express js", "next js", "vue js", "angular", "svelte",
  "html", "css", "css flexbox", "css grid", "tailwind css", "bootstrap",
  "sql", "sql joins", "postgres", "mysql", "mongodb", "redis", "kafka",
  "docker", "docker compose", "kubernetes", "terraform", "aws", "aws lambda",
  "azure", "gcp", "linux", "bash scripting", "git", "git rebase", "vim",
  "data structures", "algorithms", "dynamic programming", "binary search",
  "system design", "consistent hashing", "load balancing", "rest api",
  "graphql", "websockets", "machine learning", "deep learning", "pytorch",
  "tensorflow", "llm", "transformers", "prompt engineering", "rust", "go lang",
];

/** Generic everyday searches — adds breadth and realistic "near me" / how-to traffic. */
const GENERIC: string[] = [
  "weather", "news", "stock market", "bitcoin price", "recipes",
  "pizza near me", "coffee near me", "gym near me", "atm near me",
  "best laptop", "best phone", "best headphones", "cheap flights",
  "hotels", "restaurants", "movies", "netflix", "youtube", "spotify",
  "how to cook rice", "how to tie a tie", "how to invest", "how to lose weight",
  "translate", "calculator", "calendar", "maps", "directions", "covid",
  "jobs", "resume template", "cover letter", "salary", "interview tips",
  "online courses", "free certificates", "scholarships", "visa", "passport",
  "car insurance", "home loan", "credit card", "tax filing", "mutual funds",
];

/**
 * Modifiers appended to heads. These are what create the long tail and the
 * prefix-rich variety ("iphone 15 pro max price", "iphone 15 pro max review near me").
 * Includes prices, reviews, "near me", spec bumps, and a sweep of years.
 */
const MODIFIERS: string[] = [
  "", "price", "review", "reviews", "near me", "online", "deals", "offers",
  "specs", "vs", "alternative", "for beginners", "tutorial", "guide",
  "cheap", "best", "2023", "2024", "2025", "second hand", "refurbished",
  "in india", "in usa", "free shipping", "discount", "coupon", "buy",
  "release date", "battery life", "comparison", "pros and cons", "setup",
];

// ---------------------------------------------------------------------------
// Build the candidate query set.
// ---------------------------------------------------------------------------

/**
 * Generate distinct "<head> <modifier>" combinations across all vocabularies.
 * We use a Set keyed by the final string to GUARANTEE distinctness (the spec
 * requires DISTINCT queries; duplicate keys would also violate the trie's
 * build-once contract and the queries-table primary key downstream).
 *
 * If the natural combinations fall short of TARGET_ROWS we top up with numeric/
 * word suffixes (see below) rather than weakening realism elsewhere.
 */
function buildDistinctQueries(rng: () => number): string[] {
  const heads = [...BRANDS, ...TECH, ...GENERIC];
  const seen = new Set<string>();

  // Cartesian-ish product: every head crossed with every modifier.
  // head + "" yields the bare head (e.g. "iphone") so short, high-value
  // prefixes exist as queries in their own right.
  for (const head of heads) {
    for (const mod of MODIFIERS) {
      const q = mod === "" ? head : `${head} ${mod}`;
      seen.add(normalize(q));
    }
  }

  // Two-modifier combinations greatly expand the space ("iphone 15 pro price india")
  // and deepen the long tail. We stop adding once we comfortably exceed the target.
  outer: for (const head of heads) {
    for (const m1 of MODIFIERS) {
      if (m1 === "") continue;
      for (const m2 of MODIFIERS) {
        if (m2 === "" || m2 === m1) continue;
        seen.add(normalize(`${head} ${m1} ${m2}`));
        // Generate a healthy surplus so dedup + the >150k requirement are safe.
        if (seen.size >= TARGET_ROWS * 2) break outer;
      }
    }
  }

  let queries = [...seen];

  // Safety net: if (somehow) still short, append suffixes to existing queries to
  // reach the target WITHOUT duplicates. Realism is slightly lower for these tail
  // rows, but they remain plausible "model number" style queries.
  const suffixWords = ["pro", "plus", "ultra", "lite", "mini", "max", "edition"];
  let n = 1;
  while (queries.length < TARGET_ROWS) {
    const baseQ = queries[Math.floor(rng() * queries.length)];
    const word = suffixWords[Math.floor(rng() * suffixWords.length)];
    const candidate = normalize(`${baseQ} ${word} ${n}`);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      queries.push(candidate);
    }
    n++;
  }

  return queries;
}

/** Normalize exactly like the read path will (trim + collapse spaces + lowercase). */
function normalize(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------------------------------------------------------------------------
// Assign Zipfian counts.
// ---------------------------------------------------------------------------

/**
 * Shuffle then rank: we Fisher-Yates shuffle the distinct queries (seeded) so the
 * popularity ranking is NOT alphabetical — otherwise every "a..." query would be
 * the most popular and the demo would look fake. After shuffling, array index + 1
 * is the Zipf rank, and count = round( BASE / rank^s * jitter ), floored at MIN_COUNT.
 */
function assignZipfCounts(
  queries: string[],
  rng: () => number,
): Array<{ query: string; count: number }> {
  // Fisher-Yates shuffle (seeded) to decouple popularity rank from alphabetical order.
  for (let i = queries.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [queries[i], queries[j]] = [queries[j], queries[i]];
  }

  return queries.map((query, idx) => {
    const rank = idx + 1; // rank 1 = most popular.
    const zipf = BASE / Math.pow(rank, ZIPF_EXPONENT);
    // Multiplicative jitter in [1-J, 1+J]; seeded => reproducible.
    const jitterFactor = 1 - JITTER + rng() * (2 * JITTER);
    const count = Math.max(MIN_COUNT, Math.round(zipf * jitterFactor));
    return { query, count };
  });
}

// ---------------------------------------------------------------------------
// CSV writing.
// ---------------------------------------------------------------------------

/**
 * Emit "query,count" with a header. Queries can contain commas (none in our
 * vocab do today, but be defensive) or quotes, so we apply minimal RFC-4180
 * CSV quoting: wrap in quotes and double any embedded quote when needed. This
 * keeps the file parseable by the ingest script and by spreadsheets.
 */
function toCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function main(): void {
  const startedAt = Date.now();
  console.log(`[dataset] seed=${SEED} target>=${TARGET_ROWS} zipf s=${ZIPF_EXPONENT} base=${BASE}`);

  const rng = makeRng(SEED);

  console.log("[dataset] building distinct query combinations...");
  const distinct = buildDistinctQueries(rng);
  console.log(`[dataset] built ${distinct.length.toLocaleString()} distinct queries`);

  console.log("[dataset] assigning Zipfian counts (shuffle + rank)...");
  const rows = assignZipfCounts(distinct, rng);

  // Sort by count descending purely for human readability of the CSV (the head
  // queries sit at the top, mirroring the spec's example). Ingestion order does
  // not matter for correctness — the DB primary key and trie handle ordering —
  // but a sorted file is nicer to eyeball during the viva.
  rows.sort((a, b) => b.count - a.count);

  console.log("[dataset] serializing CSV...");
  // Build the file in one string then write once: for ~150k short lines this is a
  // few MB — trivial for memory — and a single writeFileSync is simpler and faster
  // than thousands of append calls.
  const lines: string[] = ["query,count"];
  for (const { query, count } of rows) {
    lines.push(`${toCsvField(query)},${count}`);
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, lines.join("\n") + "\n", "utf8");

  // Summary stats for the report.
  const counts = rows.map((r) => r.count);
  const maxCount = counts[0]; // rows is sorted desc.
  const minCount = counts[counts.length - 1];
  const elapsedMs = Date.now() - startedAt;

  console.log("[dataset] done.");
  console.log(`  file:       ${OUTPUT_PATH}`);
  console.log(`  rows:       ${rows.length.toLocaleString()} (distinct queries)`);
  console.log(`  count span: ${minCount.toLocaleString()} .. ${maxCount.toLocaleString()}`);
  console.log(`  sample head:`);
  for (const r of rows.slice(0, 3)) console.log(`    ${r.query} -> ${r.count}`);
  console.log(`  sample tail:`);
  for (const r of rows.slice(-3)) console.log(`    ${r.query} -> ${r.count}`);
  console.log(`  elapsed:    ${elapsedMs} ms`);
}

main();
