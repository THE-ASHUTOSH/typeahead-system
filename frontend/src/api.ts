/**
 * api.ts — the single typed HTTP client wrapping every backend call.
 *
 * WHY one module: keeping all fetch calls + their response types here means the rest of
 * the UI never hand-builds a URL or re-declares a response shape. If the API changes, this
 * is the only file to touch. The types below mirror the EXACT JSON the Express routes
 * return (see backend/src/app.ts and backend/src/store/QueryStore.ts) so the components
 * get full type-safety on the wire.
 *
 * All paths are RELATIVE ("/suggest", not "http://localhost:8080/suggest"): in dev the
 * Vite proxy forwards them to the API (see vite.config.ts); in production the built SPA is
 * served by the same Express process, so the relative paths resolve directly. No host is
 * ever hardcoded.
 */

// ── Response types (mirror the backend exactly) ──────────────────────────────────────

/** Ranking mode the single /suggest endpoint supports (spec §7). */
export type SuggestMode = "basic" | "recency";

/**
 * One suggestion as the cache/route returns it: {query, score}.
 * NOTE the shape is {query, score} (NOT {query, count}) — the backend maps the trie's
 * count into a generic `score` so the cache stays ranking-agnostic. In basic mode `score`
 * IS the all-time count; in recency mode it is the blended recency score.
 */
export interface Suggestion {
  query: string;
  score: number;
}

/** Where a /suggest result came from: Redis cache hit, trie rebuild (miss), or no lookup at all. */
export type SuggestSource = "cache" | "trie" | "empty";

/** Response of GET /suggest. */
export interface SuggestResponse {
  suggestions: Suggestion[];
  /** "cache" (Redis hit), "trie" (cache miss, rebuilt from source), or "empty" (no q → no lookup). */
  source: SuggestSource;
  /** The owning Redis node id (null only for the empty-prefix early return). */
  node: string | null;
  mode: SuggestMode;
}

/** Response of POST /search — the dummy search response (spec §4.2). */
export interface SearchResponse {
  message: string; // "Searched"
}

/** One trending row: a query plus its recent-activity window counts. */
export interface TrendingRow {
  query: string;
  count1h: number;
  count24h: number;
}

/** Response of GET /trending. */
export interface TrendingResponse {
  trending: TrendingRow[];
}

// (The /cache/debug endpoint still exists on the backend for the consistent-hashing demo;
//  it's exercised via curl / the runtime endpoint, not the UI, so there's no client for it here.)

// ── Low-level fetch helper ────────────────────────────────────────────────────────────

/**
 * Thin wrapper around fetch that:
 *   * forwards an AbortSignal so callers can CANCEL stale in-flight requests, and
 *   * turns a non-2xx response into a thrown Error carrying the server's {error} message,
 *     so the components' try/catch error states get a friendly message instead of silently
 *     parsing an error body as success.
 */
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    // The API's error middleware returns { error: string }; surface it if present.
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // Non-JSON error body — keep the status-line detail.
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// ── Public API calls ──────────────────────────────────────────────────────────────────

/**
 * GET /suggest?q=&mode= — fetch up to 10 prefix suggestions for the current mode.
 * The caller passes an AbortSignal; an aborted call rejects with an AbortError which the
 * caller ignores (race-cancellation — we never render a stale prefix's results).
 */
export function fetchSuggestions(
  q: string,
  mode: SuggestMode,
  signal?: AbortSignal,
): Promise<SuggestResponse> {
  const params = new URLSearchParams({ q, mode });
  return getJson<SuggestResponse>(`/suggest?${params.toString()}`, signal);
}

/** GET /trending?limit= — the global "hot right now" queries (spec §7). */
export function fetchTrending(limit: number, signal?: AbortSignal): Promise<TrendingResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  return getJson<TrendingResponse>(`/trending?${params.toString()}`, signal);
}

/**
 * POST /search {q} — submit a search. Returns the dummy {message:"Searched"}.
 * This is the only mutating call; the backend buffers it into the BatchWriter and returns
 * 202 immediately (it does NOT write to Postgres synchronously).
 */
export async function postSearch(q: string): Promise<SearchResponse> {
  const res = await fetch("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q }),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* keep status-line detail */
    }
    throw new Error(detail);
  }
  return (await res.json()) as SearchResponse;
}
