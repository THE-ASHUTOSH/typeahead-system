import type { TrendingRow } from "../api.ts";

/**
 * TrendingPanel — the "trending searches" section (spec §7 / §9).
 *
 * Trending is its OWN endpoint (GET /trending), ranked by recent activity (1h then 24h),
 * not by all-time popularity — so it answers "what's hot right now". It lives in the
 * sidebar and is always visible; clicking a row runs that query (a common typeahead
 * affordance and handy for the demo). It owns no fetching itself — App passes data +
 * loading/error so there is one place that talks to the API.
 */
export function TrendingPanel({
  rows,
  loading,
  error,
  updating,
  onPick,
}: {
  rows: TrendingRow[];
  loading: boolean;
  error: string | null;
  /** True while we're waiting out the batch flush after a submit before re-reading trending. */
  updating: boolean;
  onPick: (query: string) => void;
}) {
  return (
    <section className="panel" aria-label="Trending searches">
      <h2 className="panel__title">
        Trending now
        {/* "updating…" hint: after a submit the new activity isn't visible until the BatchWriter
            flushes to search_events, so we show this rather than letting it look like nothing happened. */}
        {updating && <span className="panel__hint"> · updating…</span>}
      </h2>

      {/* Loading state (spec §9): spinner while the first trending fetch is in flight. */}
      {loading && rows.length === 0 && (
        <div className="status status--muted">
          <span className="spinner" aria-hidden="true" />
          Loading trending…
        </div>
      )}

      {/* Error state (spec §9): friendly message, never a raw stack trace. */}
      {error && !loading && (
        <div className="status status--error" role="alert">
          Couldn’t load trending: {error}
        </div>
      )}

      {/* Empty state: trending only has rows once searches have been submitted (it reads
          search_events, which the BatchWriter fills on flush). Tell the user, don't show blank. */}
      {!loading && !error && rows.length === 0 && (
        <div className="status status--muted">
          No trending searches yet — submit a few searches to populate it.
        </div>
      )}

      {rows.length > 0 && (
        <ol className="trending__list">
          {rows.map((row, i) => (
            <li
              key={row.query}
              className="trending__item"
              onClick={() => onPick(row.query)}
              // Keyboard: trending rows are activatable too. role=button + tabIndex makes
              // each row focusable; Enter/Space triggers the same pick as a click.
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPick(row.query);
                }
              }}
            >
              <span className="trending__rank">{i + 1}</span>
              <span className="trending__query">{row.query}</span>
              {/* Show both windows so the recency basis is visible in the demo. */}
              <span className="trending__counts" title="searches in last 1h / 24h">
                {row.count1h} / {row.count24h}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
