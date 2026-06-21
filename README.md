# Search Typeahead System

A search-as-you-type suggestion system (like the autocomplete in search engines and
e-commerce sites). It suggests popular queries while you type, records searches, ranks
suggestions by popularity **and** recency, serves reads from a **distributed cache routed
by consistent hashing**, and reduces database write pressure with **batch writes**.

The emphasis is the **backend data-system design**: how query-count data is stored, how
suggestions are served with low latency, how the cache is distributed, and how write
pressure is reduced.

## What it does (mapped to the grading rubric)

| Component | Marks | Where |
|---|---|---|
| **Basic implementation** — dataset ingestion, search UI, `GET /suggest`, `POST /search`, query-count updates, distributed cache with consistent hashing | 60 | `trie/`, `cache/`, `store/`, `app.ts`, `frontend/` |
| **Trending searches** — recency-aware ranking + explanation | 20 | `ranking/recency.ts`, `store/QueryStore.ts` (windows), `/trending` |
| **Batch writes** — buffering, aggregation, flush, write-reduction evidence, failure trade-offs | 20 | `batch/BatchWriter.ts` |

## Architecture at a glance

```
        React UI (Vite, :5173)
          │  debounced GET /suggest?q=
          │  POST /search (Enter)
          ▼
   Express + TypeScript API (:8080)
   ├─ /suggest → consistent-hash ring → Redis node → HIT? return : MISS → Trie → cache w/ TTL
   ├─ /search  → {message:"Searched"} → BatchWriter buffer → flush → Postgres + invalidate
   ├─ /trending, /cache/debug, /cache/nodes, /metrics
   ▼
   Redis ×3 (cache nodes)        Postgres (primary store)
   redis-0/1/2 via Docker        queries + search_events
```

Full details and a request-flow diagram: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
API reference: **[docs/API.md](docs/API.md)**.

## Tech stack

- **Backend:** Node.js + Express + TypeScript (strict)
- **Cache:** 3 real **Redis** nodes (Docker), routed by **our own consistent-hash ring** (not Redis Cluster — the routing is our code, so `/cache/debug` can explain it)
- **Primary store:** **Postgres** — `queries(query, count, last_searched)` + `search_events(query, hits, ts)`
- **Dataset:** auto-generated ~162k `(query, count)` rows with a Zipfian distribution
- **Frontend:** React + Vite
- **Recency model:** sliding time-windows — `score = 3·count1h + 1.5·count24h + 1·allTime`

## Prerequisites

- **Docker** (with Compose v2 — `docker compose ...`)
- **Node.js 18+** (Node 22 recommended) and **npm**

## Quick start

The easiest path is the included launcher:

```bash
./run.sh setup    # one-time: starts Docker, installs deps, generates + ingests the dataset
./run.sh dev      # starts the API (:8080) and the UI (:5173) together
```

Then open **http://localhost:5173** and start typing.

### Manual steps (what `run.sh` does)

```bash
# 1. Start the databases (Postgres + 3 Redis nodes)
docker compose up -d                 # wait until healthy: docker compose ps

# 2. Backend — one-time setup
cd backend
npm install
npm run dataset                      # generates ../data/queries.csv (~162k rows)
npm run ingest                       # loads the CSV into Postgres (idempotent)

# 3. Backend — run the API
npm run dev                          # http://localhost:8080  (leave running)

# 4. Frontend — in another terminal
cd ../frontend
npm install
npm run dev                          # http://localhost:5173  (leave running)
```

### Other `run.sh` commands

```bash
./run.sh up        # start docker infra only
./run.sh api       # run only the backend API
./run.sh ui        # run only the frontend
./run.sh bench     # run the performance benchmark (API must be running)
./run.sh test      # run the backend unit tests
./run.sh down      # stop infra (keeps data)
./run.sh reset     # stop infra AND wipe the DB volume (fresh start)
```

## Dataset

The dataset is **generated**, not downloaded, so there's nothing to fetch and it's fully
reproducible. `scripts/generate-dataset.ts` produces ~162,000 **distinct** realistic
queries (brands, products, tech terms × modifiers like `price`, `review`, `near me`,
years) with counts following a **Zipfian (power-law)** distribution — a few very popular
queries and a long tail — which is how real search traffic looks. A seeded PRNG makes
re-runs produce the identical file. `scripts/ingest.ts` bulk-loads the CSV into Postgres.

> The minimum required by the assignment is 100,000 queries; this generates ~162k.

## Tests

```bash
cd backend && npm test     # 50 unit tests (Trie, consistent-hash ring, batch writer, recency ranking)
```

These are **pure-logic** tests — no Docker/DB/Redis needed — including the load-bearing ones:
the ring's key-movement property (only ~1/N keys move when a node is added) and the trie's
top-K cache matching a brute-force oracle.

## Performance (measured)

From `npm run bench` (3000 suggest requests @ concurrency 50, hot-skewed prefixes; 1000
search submissions over 50 distinct queries). Full report: `reports/perf.md`.

| Metric | Result |
|---|---|
| Throughput | ~14,900 req/s |
| Suggest latency | p50 **2.5 ms**, p95 **8.5 ms**, p99 10.3 ms |
| Cache hit rate (warm) | **98.9%** |
| Write reduction | 1000 submissions → **50 DB writes** (**950 saved**, ~20×) |
| Ring distribution | redis-0: 220, redis-1: 269, redis-2: 213 |

## Demo each rubric feature

With the API running on `:8080`:

**Suggestions (basic, sorted by count):**
```bash
curl "http://localhost:8080/suggest?q=iph"
```

**Mixed case / empty / no-match handled gracefully:**
```bash
curl "http://localhost:8080/suggest?q=IPH"          # same as 'iph'
curl "http://localhost:8080/suggest?q="             # {suggestions:[], source:"empty"}
curl "http://localhost:8080/suggest?q=zzqx"         # {suggestions:[]}
```

**Search submission (dummy response + buffered write):**
```bash
curl -X POST localhost:8080/search -H 'Content-Type: application/json' -d '{"q":"iphone"}'
# → {"message":"Searched"}
```

**Consistent hashing — which node owns a prefix, and live rebalancing:**
```bash
curl "http://localhost:8080/cache/debug?prefix=iph"             # owningNode, ringPosition, ringStats
curl -X POST localhost:8080/cache/nodes \
  -H 'Content-Type: application/json' -d '{"id":"redis-3","host":"localhost","port":6381}'
# compare ringStats before/after — only a fraction of keys move
curl -X DELETE localhost:8080/cache/nodes/redis-3
```

**Trending (recent activity) and basic-vs-recency ranking:**
```bash
# submit some searches, wait ~2s for the flush, then:
curl "http://localhost:8080/trending"
curl "http://localhost:8080/suggest?q=iphone%20ca&mode=basic"     # by all-time count
curl "http://localhost:8080/suggest?q=iphone%20ca&mode=recency"   # recency-boosted
```
Or use the **mode toggle in the UI** to watch the order change for the same prefix.

**Batch write-reduction evidence:**
```bash
curl "http://localhost:8080/metrics"   # batch.writesSaved, db.dbWrites, cache hit rate, p95 latency
```

## Design choices & trade-offs

Summarized in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. Headlines:

- **Consistent hashing over `hash % N`** so adding/removing a cache node moves only ~1/N of keys instead of nearly all of them (which would wipe the cache).
- **Cache-aside (lazy) over write-through** — the trie/Postgres is the source of truth; the cache only memoizes derived top-K, so a miss is always recoverable and the cache layer stays ranking-agnostic.
- **Build-once trie + rebuild-on-flush** instead of in-place count updates — keeps the per-node top-K cache simple and correct (no eviction-corruption), at the cost of a periodic O(dataset) rebuild.
- **Batching trades durability for throughput** — buffered counts are lost if the process hard-crashes before a flush (bounded to ~2s of data); graceful shutdown flushes the tail.
- **Sliding windows for recency** — a spike ages out of the 1h then 24h window automatically, so nothing is permanently over-ranked.

## Project layout

```
backend/src/
  config.ts            env-driven knobs (ports, TTL, weights, batch size, vnodes)
  index.ts             bootstrap: store + trie + cache + batch writer + server lifecycle
  app.ts               Express routes (the HTTP layer only)
  trie/Trie.ts         prefix tree with per-node top-K cache
  cache/
    ConsistentHashRing.ts   our hash ring with virtual nodes
    RedisCacheNode.ts       one resilient ioredis client per node
    CacheService.ts         cache-aside facade routed by the ring
  store/
    QueryStore.ts      the only Postgres access; single multi-row upsert; window queries
    schema.sql         the one canonical schema (queries + search_events)
  ranking/
    basic.ts           sort by all-time count (60% path)
    recency.ts         sliding-window blended score (20% path)
  batch/BatchWriter.ts buffer → aggregate → flush, with write-reduction metrics
  metrics/             cache hit/miss + latency (p50/p95)
frontend/              React + Vite UI
scripts/               generate-dataset.ts, ingest.ts, bench.ts
docs/                  ARCHITECTURE.md, API.md (+ ASSIGNMENT.md, study/ — study-only)
reports/               perf.json, perf.md (generated by the benchmark)
docker-compose.yml     postgres + redis-0/1/2
run.sh                 one-stop launcher
```
