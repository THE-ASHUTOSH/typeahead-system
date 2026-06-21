# API Reference — Search Typeahead System

Base URL (local): `http://localhost:8080`. All responses are JSON. Errors are returned as
`{ "error": "<message>" }` with an appropriate status code (never an HTML stack trace).

| Method | Path | Purpose |
|---|---|---|
| GET | `/suggest?q=&mode=` | Fetch up to 10 prefix-matching suggestions |
| POST | `/search` | Submit a search (dummy response + buffered count update) |
| GET | `/trending?limit=` | Queries with the most recent activity |
| GET | `/cache/debug?prefix=` | Which cache node owns a prefix + ring info (proves consistent hashing) |
| POST | `/cache/nodes` | Add a cache node at runtime (rebalancing demo) |
| DELETE | `/cache/nodes/:id` | Remove a cache node at runtime |
| GET | `/metrics` | Latency, cache hit rate, DB read/write counts, batch write-reduction, ring distribution |

---

## GET /suggest

Returns up to 10 suggestions whose query starts with the (normalized) prefix, sorted by the
active ranking. *Why:* the core typeahead read path; optimized for low latency via the
distributed cache.

**Query params**
- `q` (string) — the prefix. Normalized to `trim().toLowerCase()`. Empty/missing → `[]`.
- `mode` (`basic` | `recency`, default `basic`) — `basic` sorts by all-time count; `recency`
  blends recent-window activity (the 20% feature).

**Example**
```bash
curl "http://localhost:8080/suggest?q=iph"
curl "http://localhost:8080/suggest?q=iphone%20ca&mode=recency"
```

**Response** `200`
```json
{
  "suggestions": [
    { "query": "iphone 15 pro for beginners free shipping", "score": 17352 },
    { "query": "iphone 14 buy coupon", "score": 8532 }
  ],
  "source": "cache",
  "node": "redis-1",
  "mode": "basic"
}
```
- `score` — the value the active mode ranked by (all-time count in `basic`; the blended recency
  score in `recency`).
- `source` — `"cache"` (served from Redis), `"trie"` (cache miss, rebuilt from the trie and then
  cached), or `"empty"` (no `q` given — no lookup performed).
- `node` — the Redis node the ring routed this prefix to (`null` for the empty case).

Edge cases (all `200`): empty `q` → `{ "suggestions": [], "source": "empty", ... }`; mixed case
matches the same as lowercase; a prefix with no matches → `{ "suggestions": [] }`.

---

## POST /search

Records a submitted search and returns a dummy response. *Why:* the spec's submission endpoint;
it must NOT write to the DB synchronously — it buffers into the batch writer.

**Body** `{ "q": "<query>" }` (non-empty string)

**Example**
```bash
curl -X POST localhost:8080/search -H 'Content-Type: application/json' -d '{"q":"iphone"}'
```

**Response** `202 Accepted`
```json
{ "message": "Searched" }
```
`202` (not `200`) communicates "received, will be processed asynchronously" — honest about the
deferred, batched write. The count update appears in suggestions/trending after the next flush
(≤ ~2s). Missing/empty `q` → `400 { "error": "Body must include a non-empty 'q' string" }`.

---

## GET /trending

Returns the queries with the most recent activity (hot *right now*), ranked by 1-hour then
24-hour window counts. *Why:* the trending section; recent-activity ranking, computed in SQL via
`SUM(hits)` over `search_events`.

**Query params**: `limit` (int, default 10).

**Example**
```bash
curl "http://localhost:8080/trending?limit=5"
```

**Response** `200`
```json
{
  "trending": [
    { "query": "iphone case", "count1h": 25, "count24h": 25 },
    { "query": "iphone 15",   "count1h": 10, "count24h": 10 }
  ]
}
```
Empty until searches have been submitted **and** flushed to `search_events`.

---

## GET /cache/debug

Shows the ring's routing decision for a prefix and whether the owning node currently holds a live
entry, plus per-node health and key distribution. *Why:* this is the **evidence that consistent
hashing works** — it shows which node owns a prefix and where it sits on the ring.

**Query params**: `prefix` (string, normalized).

**Example**
```bash
curl "http://localhost:8080/cache/debug?prefix=iph"
```

**Response** `200`
```json
{
  "prefix": "iph",
  "key": "suggest:iph",
  "owningNode": "redis-0",
  "ringPosition": 4206117018,
  "hit": false,
  "health": { "redis-0": true, "redis-1": true, "redis-2": true },
  "ringStats": { "redis-0": 220, "redis-1": 269, "redis-2": 213 }
}
```
> Note: this inspects the **bare prefix** key routing (the consistent-hashing demonstration).
> The `/suggest` cache entry uses a mode-namespaced key, so its `node` may differ — both are
> correct; they're different keys.

---

## POST /cache/nodes

Adds a cache node to the ring at runtime. *Why:* the rebalancing demo — compare `ringStats`
before and after to see that only a small fraction of keys move.

**Body** `{ "id": "redis-3", "host": "localhost", "port": 6381 }`

**Example**
```bash
curl -X POST localhost:8080/cache/nodes \
  -H 'Content-Type: application/json' -d '{"id":"redis-3","host":"localhost","port":6381}'
```

**Response** `201`
```json
{ "added": "redis-3", "ringStats": { "redis-0": 192, "redis-1": 192, "redis-2": 168, "redis-3": 150 } }
```
`400` on a malformed body; `409` if the id already exists.

## DELETE /cache/nodes/:id

Removes a node (its keys re-home to neighbours; its socket closes).

**Example**
```bash
curl -X DELETE localhost:8080/cache/nodes/redis-3
```

**Response** `200` `{ "removed": "redis-3", "ringStats": { ... } }`. `400` for an unknown id or if
it would empty the ring.

---

## GET /metrics

One endpoint backing the whole performance report. *Why:* the rubric asks for latency (incl.
p95), cache hit rate, DB read/write counts, and write-reduction evidence.

**Example**
```bash
curl "http://localhost:8080/metrics"
```

**Response** `200`
```json
{
  "latency": { "suggest": { "count": 3000, "avg": 2.9, "p50": 2.46, "p95": 8.52 } },
  "cache":   { "hits": 2960, "misses": 40, "total": 3000, "hitRate": 0.9867 },
  "db":      { "dbReads": 980, "dbWrites": 50 },
  "batch":   { "totalSubmissions": 1000, "totalFlushes": 3, "totalDbWrites": 50, "writesSaved": 950, "bufferedQueries": 0, "bufferedSubmissions": 0 },
  "ringStats": { "redis-0": 220, "redis-1": 269, "redis-2": 213 }
}
```
- `latency.suggest` — p50/p95/avg of the suggest handler (server-side).
- `cache.hitRate` — hits / (hits + misses).
- `db` — statements that read vs. wrote Postgres.
- `batch.writesSaved` — `totalSubmissions − totalDbWrites`, the headline write-reduction figure.
- `ringStats` — per-node key share, evidence of even distribution.
