-- ============================================================================
-- schema.sql — the Postgres PRIMARY STORE for the typeahead system.
--
-- This file is read and executed by QueryStore.init() at boot. Every statement
-- is `IF NOT EXISTS`, so running it repeatedly (every boot, every test) is safe
-- and idempotent — we never need a separate "migrations vs. create" code path
-- for an assignment-sized schema.
--
-- TWO TABLES, TWO JOBS:
--   queries        — the durable, authoritative all-time count per query. This is
--                    the source of truth the prefix search (GET /suggest) reads from.
--   search_events  — an append-mostly activity log used ONLY to compute the
--                    recency windows (1h / 24h) for the trending ranking.
-- Splitting them keeps each concern simple: `queries` answers "how popular ever?",
-- `search_events` answers "how popular lately?".
-- ============================================================================

-- ----------------------------------------------------------------------------
-- queries: one row per distinct query, holding its lifetime search count.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS queries (
  -- The query text IS the natural primary key: queries are unique by their text,
  -- and ON CONFLICT (query) upserts depend on this being the PK / unique key.
  query         TEXT        PRIMARY KEY,

  -- BIGINT, not INT: a popular query on a 150k-row Zipfian dataset can exceed the
  -- ~2.1 billion INT ceiling once submissions accumulate over time. DEFAULT 0 so a
  -- freshly-inserted query (seen for the first time via /search) starts from zero and
  -- the upsert's `count = count + EXCLUDED.count` lands on a sane base.
  count         BIGINT      NOT NULL DEFAULT 0,

  -- When this query was last searched. Useful for debugging / "recently touched"
  -- diagnostics. We maintain it on every upsert (= now()). It is NOT the recency
  -- signal used for ranking — that comes from search_events windows — because a single
  -- "last_searched" timestamp can't express "how many times in the last hour".
  last_searched TIMESTAMPTZ
);

-- PREFIX-SEARCH INDEX (the one that makes GET /suggest fast on a cache miss).
-- Suggestions are served by a SQL prefix query: `WHERE query LIKE 'pre%'`. A plain
-- PRIMARY KEY btree CANNOT serve `LIKE 'pre%'` as a range scan, because the default
-- index sorts by the database's collation rather than raw byte order, and `LIKE`
-- anchored matching needs byte-order. The `text_pattern_ops` operator class builds
-- the btree in the order `LIKE 'x%'` can range-scan, so the query becomes a bounded
-- scan of just the matching prefix range instead of a full-table scan. The cache
-- (Redis) absorbs ~99% of suggestion reads, so this index only does work on a miss,
-- but when it does, it keeps that miss fast even on ~162k rows.
CREATE INDEX IF NOT EXISTS idx_queries_prefix
  ON queries (query text_pattern_ops);

-- ----------------------------------------------------------------------------
-- search_events: the recency activity log feeding the 1h / 24h trending windows.
-- ----------------------------------------------------------------------------
--
-- DESIGN CHOICE (the important one to defend in the viva) — "one aggregated row
-- per query per flush", NOT "one row per individual search":
--
--   Each batch flush inserts ONE row per distinct query with `hits = delta`
--   (how many times that query was searched in this batch) and `ts = now()`.
--   Window counts are then computed with SUM(hits), not COUNT(*).
--
-- WHY this shape:
--   * Correctness: SUM(hits) WHERE ts >= now() - interval '1 hour' still yields the
--     true number of searches in the last hour, because each row's `hits` carries
--     the count for that moment. It is a faithful recency signal.
--   * Volume control: if we instead inserted one row PER search (COUNT(*) model),
--     a query searched 50 times in one flush would write 50 rows. With many hot
--     queries per flush that explodes the event-row volume. With this design the
--     number of event rows written per flush == number of DISTINCT queries in the
--     flush (small and bounded), regardless of how many times each was searched.
--   * Trade-off accepted: time resolution is coarsened to the flush boundary (all
--     `hits` from one flush share a single `ts`). For 1h/24h windows that is far
--     finer than we need, so the trade-off costs us nothing meaningful while saving
--     a large amount of write volume and storage.
--
CREATE TABLE IF NOT EXISTS search_events (
  -- Surrogate BIGSERIAL key: search_events has no natural unique key (the same
  -- query legitimately appears many times across flushes), so we use an
  -- auto-incrementing id purely to give each row a stable identity.
  id    BIGSERIAL   PRIMARY KEY,

  query TEXT        NOT NULL,

  -- How many searches this row accounts for (the flush's aggregated delta for the
  -- query). SUM(hits) over a time window reconstructs the windowed search count.
  hits  INTEGER     NOT NULL DEFAULT 1,

  -- The flush time. DEFAULT now() so an insert that omits ts still timestamps itself.
  -- This is the column every window query filters on (ts >= now() - interval ...).
  ts    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index on ts: EVERY recency query is `... WHERE ts >= now() - interval '1 hour'`
-- (or '24 hours') — a range scan over time. Without this index those scans would be
-- full-table sequential scans that get slower as the log grows; the btree on ts lets
-- Postgres jump straight to the recent tail of the log.
CREATE INDEX IF NOT EXISTS idx_search_events_ts
  ON search_events (ts);

-- Composite index on (query, ts): trending / window queries that are filtered to a
-- specific set of queries (e.g. the prefix matches we are ranking) AND a time window
-- benefit from a (query, ts) ordering — Postgres can seek to the query then range-scan
-- its recent events. The leading `query` column also serves equality lookups for a
-- single query's window. Ordering query-first (not ts-first) because the window
-- queries we run for ranking always know the exact queries they care about.
CREATE INDEX IF NOT EXISTS idx_search_events_query_ts
  ON search_events (query, ts);
