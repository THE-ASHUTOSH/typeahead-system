import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchSuggestions,
  fetchTrending,
  postSearch,
  type Suggestion,
  type SuggestMode,
  type SuggestSource,
  type TrendingRow,
} from "./api.ts";
import { useDebouncedValue } from "./hooks/useDebouncedValue.ts";
import { SuggestionDropdown } from "./components/SuggestionDropdown.tsx";
import { TrendingPanel } from "./components/TrendingPanel.tsx";
import { ModeToggle } from "./components/ModeToggle.tsx";

// ── Tunable knobs (kept here with their rationale; no magic numbers buried in logic) ──

/** Debounce window before a settled prefix triggers GET /suggest (see useDebouncedValue). */
const DEBOUNCE_MS = 200;
/** How many trending rows to request (the spec caps suggestions at 10; we match it). */
const TRENDING_LIMIT = 10;
/**
 * Delay before re-fetching trending after a submit. POST /search only BUFFERS the event into
 * the BatchWriter; it lands in search_events on the next flush, which the backend runs every
 * batchFlushMs (BATCH_FLUSH_MS, default 2000ms — see backend/src/config.ts). We wait slightly
 * longer than that flush cadence so the just-submitted query is actually persisted before we
 * read /trending, otherwise the refresh races the flush and shows stale "hot right now" data.
 */
const TRENDING_REFRESH_DELAY_MS = 2200;
/** Stable ARIA ids wiring the input (combobox) to the dropdown (listbox) for screen readers. */
const LISTBOX_ID = "suggest-listbox";
const optionId = (i: number) => `suggest-option-${i}`;

export default function App() {
  // The raw text in the box (updates every keystroke). The DEBOUNCED copy is what we fetch on.
  const [input, setInput] = useState("");
  const debouncedInput = useDebouncedValue(input, DEBOUNCE_MS);

  // Ranking mode for &mode= (basic = 60% baseline, recency = enhanced). Spec §7.
  const [mode, setMode] = useState<SuggestMode>("basic");

  // Suggestion state + its loading/error and the source/node metadata from the response.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestSource, setSuggestSource] = useState<SuggestSource | null>(null);
  const [suggestNode, setSuggestNode] = useState<string | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // Dropdown open/closed + the keyboard-highlighted row index (-1 = nothing highlighted).
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Trending state (its own endpoint, refreshed after each submitted search).
  const [trending, setTrending] = useState<TrendingRow[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [trendingError, setTrendingError] = useState<string | null>(null);

  // The dummy "Searched" response to display after a submit (spec §9).
  const [searchResult, setSearchResult] = useState<string | null>(null);

  // Brief "updating…" hint shown while we wait out the batch flush before re-reading trending.
  const [trendingUpdating, setTrendingUpdating] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Holds the in-flight trending request's controller so a newer load (mount OR post-submit)
  // can abort the previous one — same race-cancellation discipline as the suggest fetch, so a
  // slow earlier /trending response can never overwrite a newer one.
  const trendingControllerRef = useRef<AbortController | null>(null);

  // Set true the instant we submit; lets the debounced suggest effect tell "the input changed
  // because we just filled it in from a selection/submit" apart from "the user typed", so it
  // does NOT re-open the dropdown ~DEBOUNCE_MS later. Cleared on the next real keystroke.
  const justSubmittedRef = useRef(false);

  // Pending post-submit trending-refresh timer, so a rapid second submit can cancel the first
  // (we only want one delayed refresh outstanding at a time).
  const trendingRefreshTimerRef = useRef<number | null>(null);

  // ── Trending fetch ──────────────────────────────────────────────────────────────
  // Memoised so we can call it on mount AND after every submit without re-creating it.
  // Aborts any previous in-flight trending request before starting a new one (race-cancel).
  const loadTrending = useCallback(() => {
    trendingControllerRef.current?.abort();
    const controller = new AbortController();
    trendingControllerRef.current = controller;
    setTrendingLoading(true);
    fetchTrending(TRENDING_LIMIT, controller.signal)
      .then((res) => {
        setTrending(res.trending);
        setTrendingError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setTrendingError(err instanceof Error ? err.message : "Failed to load trending");
      })
      .finally(() => {
        // Only the latest controller clears the loading flag — a stale aborted call must not
        // flip it off underneath a newer in-flight request.
        if (trendingControllerRef.current === controller) {
          setTrendingLoading(false);
        }
      });
    return controller;
  }, []);

  // Load trending once on mount.
  useEffect(() => {
    const controller = loadTrending();
    return () => controller.abort();
  }, [loadTrending]);

  // On unmount, cancel any pending post-submit refresh timer so it can't fire after teardown.
  useEffect(() => {
    return () => {
      if (trendingRefreshTimerRef.current !== null) {
        window.clearTimeout(trendingRefreshTimerRef.current);
      }
    };
  }, []);

  // ── Suggestion fetch (debounced + race-cancelled) ─────────────────────────────────
  useEffect(() => {
    const q = debouncedInput.trim();

    // Empty prefix → no dropdown, no request (trending fills the empty state instead).
    if (q.length === 0) {
      setSuggestions([]);
      setSuggestSource(null);
      setSuggestNode(null);
      setSuggestError(null);
      setSuggestLoading(false);
      setActiveIndex(-1);
      return;
    }

    // RACE-CANCELLATION: each debounced prefix gets its own AbortController. When the effect
    // re-runs (prefix or mode changed) the cleanup aborts the PREVIOUS in-flight request, so a
    // slow earlier response can never overwrite a newer one (the out-of-order problem). The
    // aborted fetch rejects with AbortError, which we deliberately ignore below.
    const controller = new AbortController();
    setSuggestLoading(true);

    fetchSuggestions(q, mode, controller.signal)
      .then((res) => {
        setSuggestions(res.suggestions);
        setSuggestSource(res.source);
        setSuggestNode(res.node);
        setSuggestError(null);
        // Don't re-open the dropdown if this fetch was triggered by us filling the input from a
        // selection/submit (justSubmittedRef). Otherwise the debounce fires ~DEBOUNCE_MS after a
        // submit and the just-closed dropdown flickers back open. A real keystroke clears the
        // ref (see input onChange), so normal typing still opens the list.
        if (!justSubmittedRef.current) {
          setOpen(true);
        }
        // Reset the highlight to "nothing" on a fresh result set so Arrow keys start at the top.
        setActiveIndex(-1);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return; // expected on cancel
        setSuggestError(err instanceof Error ? err.message : "Failed to load suggestions");
      })
      .finally(() => setSuggestLoading(false));

    return () => controller.abort();
  }, [debouncedInput, mode]);

  // ── Submit a search (Enter or the Search button) ──────────────────────────────────
  const submitSearch = useCallback(
    async (rawQuery: string) => {
      const q = rawQuery.trim();
      if (q.length === 0) return; // never submit an empty query

      // Mark that the input is about to change because of a submit (not a keystroke), so the
      // debounced suggest effect won't re-open the dropdown ~DEBOUNCE_MS later. Cleared on the
      // next real keystroke (input onChange).
      justSubmittedRef.current = true;
      setOpen(false);
      setActiveIndex(-1);
      try {
        // POST /search → dummy { message: "Searched" }. The backend buffers it into the
        // BatchWriter (no synchronous DB write) and returns 202 immediately.
        const res = await postSearch(q);
        setSearchResult(`${res.message}: "${q}"`);

        // Refresh trending: the submission was recorded, so "hot right now" may have changed.
        // BUT it only becomes visible once the BatchWriter FLUSHES to search_events. An immediate
        // re-read would race the flush and show stale data, so we wait TRENDING_REFRESH_DELAY_MS
        // (slightly longer than the flush cadence) and show an "updating…" hint meanwhile.
        if (trendingRefreshTimerRef.current !== null) {
          window.clearTimeout(trendingRefreshTimerRef.current); // collapse rapid submits to one refresh
        }
        setTrendingUpdating(true);
        trendingRefreshTimerRef.current = window.setTimeout(() => {
          trendingRefreshTimerRef.current = null;
          setTrendingUpdating(false);
          loadTrending();
        }, TRENDING_REFRESH_DELAY_MS);
      } catch (err) {
        setSearchResult(
          `Search failed: ${err instanceof Error ? err.message : "unknown error"}`,
        );
        setTrendingUpdating(false);
      }
    },
    [loadTrending],
  );

  // ── Keyboard model on the input (spec §9 a11y) ─────────────────────────────────────
  // ArrowDown/Up move the highlight, wrapping at the ends; Enter submits the highlighted
  // suggestion (or the typed text if none is highlighted); Escape closes the dropdown.
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const hasList = open && suggestions.length > 0;

    if (e.key === "ArrowDown") {
      e.preventDefault(); // stop the caret from jumping to the end of the input
      if (!hasList) return;
      setActiveIndex((i) => (i + 1) % suggestions.length); // wrap to top after the last
      setOpen(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!hasList) return;
      // wrap to the bottom when stepping up past the first (and from the -1 "none" state)
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      // Enter selects the highlighted suggestion if one is active, else submits the typed text.
      if (hasList && activeIndex >= 0) {
        const chosen = suggestions[activeIndex].query;
        setInput(chosen);
        submitSearch(chosen);
      } else {
        submitSearch(input);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  // Picking a suggestion (mouse click or trending row): fill the box, run the search.
  const pickQuery = useCallback(
    (query: string) => {
      setInput(query);
      submitSearch(query);
      inputRef.current?.focus();
    },
    [submitSearch],
  );

  // aria-activedescendant points the input at the highlighted option id (or undefined when
  // nothing is highlighted) so assistive tech announces the current arrow-key selection.
  const activeDescendant =
    open && activeIndex >= 0 ? optionId(activeIndex) : undefined;

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">Search Typeahead</h1>
        <p className="app__subtitle">
          Type to see live suggestions · Enter or Search to submit · toggle ranking to compare
        </p>
      </header>

      <div className="layout">
        {/* ── Left: search + suggestions + result + (optional) cache debug ── */}
        <div>
          <section className="panel">
            <h2 className="panel__title">Search</h2>

            <div className="search">
              <div className="search__row">
                <input
                  ref={inputRef}
                  className="search__input"
                  type="text"
                  // ARIA combobox pattern: this input controls the listbox popup below.
                  role="combobox"
                  aria-expanded={open && suggestions.length > 0}
                  aria-controls={LISTBOX_ID}
                  aria-autocomplete="list"
                  aria-activedescendant={activeDescendant}
                  placeholder="Search for anything…"
                  value={input}
                  autoFocus
                  onChange={(e) => {
                    justSubmittedRef.current = false; // a real keystroke → let the dropdown open again
                    setInput(e.target.value);
                    setSearchResult(null); // clear the old "Searched" banner once typing resumes
                    setOpen(true);
                  }}
                  onFocus={() => {
                    if (suggestions.length > 0) setOpen(true);
                  }}
                  // Delay close so a suggestion mousedown registers before blur hides the list.
                  onBlur={() => window.setTimeout(() => setOpen(false), 120)}
                  onKeyDown={onInputKeyDown}
                />
                <button
                  className="search__button"
                  type="button"
                  disabled={input.trim().length === 0}
                  onClick={() => submitSearch(input)}
                >
                  Search
                </button>
              </div>

              {/* The dropdown only renders while open and there's a prefix being worked on. */}
              {open && debouncedInput.trim().length > 0 && (
                <SuggestionDropdown
                  suggestions={suggestions}
                  activeIndex={activeIndex}
                  loading={suggestLoading}
                  error={suggestError}
                  source={suggestSource}
                  node={suggestNode}
                  listboxId={LISTBOX_ID}
                  optionId={optionId}
                  onHover={setActiveIndex}
                  onPick={pickQuery}
                />
              )}
            </div>

            <ModeToggle mode={mode} onChange={setMode} />

            {/* Dummy search response display (spec §9). */}
            {searchResult && (
              <div className="result-banner" role="status">
                {searchResult}
              </div>
            )}
          </section>
        </div>

        {/* ── Right: trending sidebar (always visible) ── */}
        <TrendingPanel
          rows={trending}
          loading={trendingLoading}
          error={trendingError}
          updating={trendingUpdating}
          onPick={pickQuery}
        />
      </div>
    </div>
  );
}
