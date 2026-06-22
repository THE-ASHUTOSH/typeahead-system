/**
 * app.ts — builds and returns the Express application, given its dependencies INJECTED.
 *
 * WHY dependency injection (cache, batchWriter, store passed in, not imported):
 * the bootstrap (index.ts) owns the lifecycle (init/connect/shutdown) of the real
 * Postgres/Redis-backed instances; this module only owns ROUTING. Passing the
 * collaborators in means the app can be constructed in a test with fakes (a stub
 * store, a stub cache) and exercised with supertest — no Docker required.
 * It also keeps each concern in one place: SQL lives in QueryStore, ranking in
 * ranking/, caching in CacheService, and HTTP wiring lives here.
 *
 * Suggestions on a cache MISS come straight from the store's SQL prefix search
 * (`store.searchPrefix`), so this module never holds an in-memory index of its own —
 * the cache absorbs the hot reads and Postgres is the source of truth behind it.
 */

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { CacheService } from "./cache/CacheService.js";
import type { BatchWriter } from "./batch/BatchWriter.js";
import type { QueryStore, QueryRow } from "./store/QueryStore.js";
import type { Suggestion as CacheSuggestion } from "./cache/types.js";
import { rankByCount } from "./ranking/basic.js";
import { rankRecencyAware, type RecencyCandidate } from "./ranking/recency.js";
import { getCacheMetrics } from "./metrics/cacheMetrics.js";
import { recordLatency, latencySnapshot } from "./metrics/latency.js";

/** The two ranking modes the single /suggest endpoint supports (spec §7). */
export type SuggestMode = "basic" | "recency";

/**
 * Everything app.ts needs from the outside world. Injected by index.ts so this file
 * never constructs (or closes) a Postgres pool or a Redis socket itself.
 */
export interface AppDeps {
  cache: CacheService;
  batchWriter: BatchWriter;
  store: QueryStore;
  /** Default ranking mode when the client doesn't pass ?mode=. "basic" is the 60% path. */
  defaultMode?: SuggestMode;
}

/** Normalise a raw query/prefix the SAME way the store and cache do (trim + lowercase),
 *  so a request, its cache key, and its SQL prefix lookup all agree on the key. */
function normalize(input: unknown): string {
  return typeof input === "string" ? input.trim().toLowerCase() : "";
}

/** Parse ?mode= into a valid SuggestMode, falling back to the configured default. */
function parseMode(raw: unknown, fallback: SuggestMode): SuggestMode {
  return raw === "recency" ? "recency" : raw === "basic" ? "basic" : fallback;
}

/**
 * Build a collision-proof, mode-namespaced cache key prefix: `${mode}:${q.length}:${q}`.
 * The length field fixes the boundary between the namespace and the (free-text) query, so no
 * value of q — even one containing ':' or the literal other-mode name — can be crafted to produce
 * the same key as the other mode. Used by /suggest (read+populate) and by index.ts's onInvalidate,
 * which MUST build the identical key or invalidation would miss. Exported so both stay in lockstep.
 */
export function makeModeKey(mode: SuggestMode, q: string): string {
  return `${mode}:${q.length}:${q}`;
}

export function buildApp(deps: AppDeps): Express {
  const { cache, batchWriter, store } = deps;
  const defaultMode: SuggestMode = deps.defaultMode ?? "basic";
  const app = express();

  // Parse JSON request bodies (POST /search, POST /cache/nodes).
  app.use(express.json());

  // --- Permissive CORS for local dev ---------------------------------------------
  // WHY: the React UI runs on the Vite dev server at http://localhost:5173, a DIFFERENT
  // origin from this API (:8080), so the browser enforces CORS on every fetch. For a
  // local single-machine demo we allow any origin (and the methods/headers the UI uses)
  // rather than pulling in the `cors` dependency — this keeps the dependency list small
  // and the behaviour explainable. In production you would lock Access-Control-Allow-Origin
  // down to the real UI origin.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    // Preflight OPTIONS requests get an immediate 204; they carry no body to handle.
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ================================================================================
  // GET /suggest?q=<prefix>&mode=basic|recency  — the hot read path.
  // ================================================================================
  app.get("/suggest", async (req: Request, res: Response, next: NextFunction) => {
    // Time the whole handler so /metrics can report p50/p95 for the read path.
    const startedAt = performance.now();
    try {
      const q = normalize(req.query.q);
      const mode = parseMode(req.query.mode, defaultMode);

      // Empty/missing prefix → return [] gracefully (spec §4.1). A typeahead box with
      // nothing typed should show no dropdown; trending is its own endpoint. source:"empty"
      // (not "db") honestly reports that NO lookup happened — neither cache nor DB was hit.
      if (q.length === 0) {
        res.json({ suggestions: [], source: "empty", node: null, mode });
        return;
      }

      // CACHE KEY NAMESPACING BY MODE: basic and recency rank the SAME prefix differently, so
      // they must NOT share a cache entry (a recency-ranked list served to a basic request would
      // be wrong). We build a LENGTH-PREFIXED key: `${mode}:${q.length}:${q}`. The length field
      // makes the key unambiguous no matter what characters q contains — given the mode and the
      // declared length, the boundary between the namespace and q is fixed, so no user-typed
      // prefix (even one containing ':' or the other mode's name) can be crafted to collide with
      // the other mode's key. (A plain string prefix like "r:"+q would leave that hole open.)
      const cacheKeyPrefix = makeModeKey(mode, q);

      // --- CACHE-ASIDE READ STEP --------------------------------------------------
      // Try the cache FIRST. On a hit we return the cached {query,score}[] verbatim — no
      // SQL prefix scan, no ranking, no DB. This is the low-latency path the rubric grades.
      const cached = await cache.getSuggestions(cacheKeyPrefix);
      if (cached.hit && cached.value !== null) {
        res.json({ suggestions: cached.value, source: "cache", node: cached.node, mode });
        return;
      }

      // --- MISS: read from the source of truth (Postgres prefix search), then cache it ---
      // store.searchPrefix runs `... WHERE query LIKE 'q%' ORDER BY count DESC LIMIT N`,
      // a bounded range scan backed by the text_pattern_ops index (see schema.sql). It
      // returns {query,count}[] already sorted by all-time count.
      const matches: QueryRow[] = await store.searchPrefix(q, config.suggestLimit);

      // Map to the CACHE's Suggestion shape {query, score}. The two shapes differ on
      // purpose (store={query,count}, cache={query,score}); we translate here so the cache
      // stays ranking-agnostic and just memoises whatever score the active mode produced.
      let suggestions: CacheSuggestion[];

      if (mode === "recency") {
        // RECENCY (the 20% path): blend all-time popularity with recent-window activity.
        // 1) Pull the matched query strings and ask the store for their 1h/24h window
        //    counts in ONE round-trip (windowCounts uses = ANY($1) — see QueryStore).
        const matchedQueries = matches.map((m) => m.query);
        const windows = await store.windowCounts(matchedQueries);
        // Index window rows by query for O(1) lookup while assembling candidates. A query
        // with no recent events simply isn't in the map → treated as count1h=count24h=0.
        const windowByQuery = new Map(windows.map((w) => [w.query, w]));

        // 2) Build RecencyCandidate[]: allTimeCount comes from the prefix search's count
        //    (the authoritative lifetime total), the window counts from search_events.
        const candidates: RecencyCandidate[] = matches.map((m) => {
          const w = windowByQuery.get(m.query);
          return {
            query: m.query,
            allTimeCount: m.count,
            count1h: w?.count1h ?? 0,
            count24h: w?.count24h ?? 0,
          };
        });

        // 3) Rank by the blended recency score and cap. score = w1·1h + w2·24h + w3·all.
        const ranked = rankRecencyAware(candidates, config.suggestLimit);
        // The cached score IS the recency score, so a future cache hit returns the same order.
        suggestions = ranked.map((c) => ({ query: c.query, score: c.score }));
      } else {
        // BASIC (the 60% path): the prefix search already sorted by all-time count, but we
        // run rankByCount to enforce the cap + a stable order. The cached score is the count
        // itself, so the dropdown can show/sort by it and a cache hit reproduces the order.
        const ranked = rankByCount(matches, config.suggestLimit);
        suggestions = ranked.map((s) => ({ query: s.query, score: s.count }));
      }

      // --- CACHE-ASIDE POPULATE STEP ---------------------------------------------
      // Store the freshly-computed list under the mode-namespaced key with the configured
      // TTL, so the next identical request hits cache. Even an empty result is cached: a
      // prefix with no matches is a legitimate, repeatable answer worth memoising.
      await cache.setSuggestions(cacheKeyPrefix, suggestions);

      res.json({ suggestions, source: "db", node: cached.node, mode });
    } catch (err) {
      next(err); // hand to the JSON error middleware below
    } finally {
      // Record latency regardless of hit/miss/error so the tail (p95) reflects reality.
      recordLatency("suggest", performance.now() - startedAt);
    }
  });

  // ================================================================================
  // POST /search  { q }  — the dummy search submission (spec §4.2).
  // ================================================================================
  app.post("/search", (req: Request, res: Response) => {
    const q = normalize((req.body as { q?: unknown } | undefined)?.q);
    // Validate: reject empty/missing q with 400 so we never buffer a blank query.
    if (q.length === 0) {
      res.status(400).json({ error: "Body must include a non-empty 'q' string" });
      return;
    }

    // THE WHOLE POINT OF BATCHING: we do NOT write to Postgres synchronously here. We
    // buffer the submission into the in-memory BatchWriter (an O(1) map increment) and
    // return immediately. Repeated queries are aggregated and flushed as ONE upsert per
    // distinct query per flush, so the DB sees far fewer writes than there are searches.
    // The trade-off (buffered deltas are lost on a hard crash before flush) is documented
    // in BatchWriter.ts; a graceful shutdown flushes the tail (see index.ts).
    batchWriter.record(q);

    // Dummy response exactly as the spec asks. 202 Accepted communicates "received, will
    // be processed asynchronously" — honest about the deferred (batched) write.
    res.status(202).json({ message: "Searched" });
  });

  // ================================================================================
  // GET /trending?limit=  — global "hot right now" queries (spec §7).
  // ================================================================================
  app.get("/trending", async (req: Request, res: Response, next: NextFunction) => {
    try {
      // TRENDING = recent-activity ranking, NOT all-time popularity. store.trending()
      // aggregates search_events over the 24h window and orders by 1h-then-24h activity
      // (computed entirely in SQL because trending is a global top-N, not a prefix lookup).
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : config.suggestLimit;
      const trending = await store.trending(limit);
      res.json({ trending });
    } catch (err) {
      next(err);
    }
  });

  // ================================================================================
  // GET /cache/debug?prefix=  — PROVES consistent hashing (spec §5 / §10).
  // ================================================================================
  app.get("/cache/debug", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prefix = normalize(req.query.prefix);
      // cache.debug() returns { prefix, key, owningNode, ringPosition, hit } — the routing
      // decision the ring made plus whether that node currently holds a live entry. This is
      // the headline evidence: it shows WHICH node owns the prefix and WHERE on the ring.
      const debug = await cache.debug(prefix);
      // Add node liveness (health()) and the ring's key-distribution (ringStats) so a single
      // call shows the whole picture: this prefix's routing + the cluster's health + spread.
      const health = await cache.health();
      res.json({ ...debug, health, ringStats: cache.ringStats() });
    } catch (err) {
      next(err);
    }
  });

  // ================================================================================
  // POST /cache/nodes { id, host, port }  and  DELETE /cache/nodes/:id
  // The CONSISTENT-HASHING REBALANCING DEMO HOOK: add/remove a cache node at runtime so
  // the viva can SHOW that only a small fraction of keys move (the ring's headline property)
  // by comparing ringStats() before and after. Returns the new distribution each time.
  // ================================================================================
  app.post("/cache/nodes", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { id?: unknown; host?: unknown; port?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const host = typeof body.host === "string" ? body.host.trim() : "";
    const port = Number(body.port);
    // Validate all three: a bad node would corrupt the ring, so fail fast with 400.
    if (id.length === 0 || host.length === 0 || !Number.isInteger(port)) {
      res.status(400).json({ error: "Body must include id (string), host (string), port (integer)" });
      return;
    }
    try {
      cache.addNode(id, host, port); // registers the Redis wrapper AND adds it to the ring
    } catch (err) {
      // addNode throws if the id already exists — surface that as a 409 conflict, not a 500.
      res.status(409).json({ error: (err as Error).message });
      return;
    }
    // Return the NEW ring distribution so the demo can diff it against the pre-add stats.
    res.status(201).json({ added: id, ringStats: cache.ringStats() });
  });

  app.delete("/cache/nodes/:id", async (req: Request, res: Response) => {
    try {
      // removeNode drops the node from the ring (its keys re-home to neighbours) and closes
      // its socket. await because closing the connection is async.
      await cache.removeNode(req.params.id);
    } catch (err) {
      // removeNode throws for an unknown id or if it would empty the ring → 400.
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json({ removed: req.params.id, ringStats: cache.ringStats() });
  });

  // ================================================================================
  // GET /metrics  — the single endpoint that backs the whole performance report.
  // ================================================================================
  app.get("/metrics", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        // p50/p95/avg suggest latency (rubric: "report latency, including p95").
        latency: latencySnapshot(),
        // hits/misses/hitRate (rubric: "report cache hit rate").
        cache: getCacheMetrics(),
        // dbReads/dbWrites (rubric: "report database read/write counts").
        db: store.getStats(),
        // totalSubmissions/totalDbWrites/writesSaved (rubric: "show write reduction").
        batch: batchWriter.getStats(),
        // per-node key share (rubric: "show consistent-hashing behaviour / even spread").
        ringStats: cache.ringStats(),
      });
    } catch (err) {
      next(err);
    }
  });

  // ================================================================================
  // Static frontend (so the whole app is one-command demoable).
  // ================================================================================
  // If the Vite build output exists, serve it from "/". In dev the UI usually runs on the
  // Vite dev server (:5173, hence the CORS above); in a built/demo setup we serve the
  // compiled SPA directly so `npm run dev` on the backend alone shows a working UI.
  //
  // Use fileURLToPath (NOT url.pathname): pathname keeps percent-encoding, so a project path
  // containing a space (".../typeahead system/...") would arrive as "typeahead%20system" and
  // existsSync would never find it. fileURLToPath decodes it to a real filesystem path.
  const frontendDist = fileURLToPath(new URL("../../frontend/dist", import.meta.url));
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
  }

  // ================================================================================
  // JSON error-handling middleware (registered LAST so it catches everything above).
  // WHY: without this, a thrown error returns Express's default HTML stack-trace page,
  // which the React client can't parse and which leaks internals. Returning {error}
  // as JSON means the UI's error state works and we never expose a stack to the browser.
  // (Express identifies error middleware by its 4-argument signature, so `next` must stay.)
  // ================================================================================
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[app] unhandled route error:", err);
    res.status(500).json({ error: message });
  });

  return app;
}
