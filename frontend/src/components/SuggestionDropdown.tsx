import { useEffect, useRef } from "react";
import type { Suggestion, SuggestSource } from "../api.ts";

/**
 * SuggestionDropdown — the typeahead dropdown that updates as the user types (spec §9).
 *
 * It is a PRESENTATIONAL component: it owns no fetching and no keyboard state. App owns the
 * data, the loading/error flags, the source/node metadata, and the keyboard-highlight index
 * (so a single keydown handler on the input can drive ArrowUp/Down — the list just renders
 * which row is active). This keeps the race-cancellation and a11y logic in one place (App).
 */
export function SuggestionDropdown({
  suggestions,
  activeIndex,
  loading,
  error,
  source,
  node,
  listboxId,
  optionId,
  onHover,
  onPick,
}: {
  suggestions: Suggestion[];
  /** Index of the keyboard-highlighted row, or -1 when nothing is highlighted. */
  activeIndex: number;
  loading: boolean;
  error: string | null;
  /** "cache" (Redis hit), "trie" (rebuilt), or "empty"/null — shown so the demo sees the cache working. */
  source: SuggestSource | null;
  node: string | null;
  /** id for the listbox container (ARIA wiring from the input's aria-controls). */
  listboxId: string;
  /** Build the DOM id for option i, so aria-activedescendant can point at the active row. */
  optionId: (i: number) => string;
  onHover: (index: number) => void;
  onPick: (query: string) => void;
}) {
  // One ref per rendered option row, so we can scroll the keyboard-highlighted one into view.
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);

  // When ArrowUp/Down moves the highlight (incl. wrapping to the far end of a scrolled list),
  // bring the active row into the visible area. block:"nearest" scrolls the minimum needed and
  // does nothing if it's already visible — so mouse hover (which also sets activeIndex) doesn't
  // cause jumpy scrolling. Hooks must run unconditionally, so this sits above the early returns.
  useEffect(() => {
    if (activeIndex < 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  // Error takes priority: if suggest failed, show why rather than a stale/empty list.
  if (error) {
    return (
      <div className="dropdown">
        <div className="status status--error" role="alert">
          Couldn’t load suggestions: {error}
        </div>
      </div>
    );
  }

  // Loading with no prior results → spinner. (If we already have results we keep showing them
  // while the next debounced fetch runs, to avoid a flicker — App passes the latest list.)
  if (loading && suggestions.length === 0) {
    return (
      <div className="dropdown">
        <div className="status status--muted">
          <span className="spinner" aria-hidden="true" />
          Searching…
        </div>
      </div>
    );
  }

  // Graceful "no matches" (spec §4.1): a prefix that matches nothing is a valid answer.
  if (!loading && suggestions.length === 0) {
    return (
      <div className="dropdown">
        <div className="status status--muted">No matching suggestions.</div>
      </div>
    );
  }

  return (
    <div className="dropdown">
      {/* role=listbox + per-row role=option is the ARIA combobox pattern: the input is the
          combobox, this is its popup listbox, and aria-activedescendant (set on the input by
          App) names the highlighted option so screen readers announce arrow-key movement. */}
      <ul className="dropdown__list" role="listbox" id={listboxId} aria-label="Suggestions">
        {suggestions.map((s, i) => (
          <li
            key={s.query}
            ref={(el) => {
              itemRefs.current[i] = el; // register this row so the scroll effect can reach it
            }}
            id={optionId(i)}
            role="option"
            aria-selected={i === activeIndex}
            className={`dropdown__item ${i === activeIndex ? "dropdown__item--active" : ""}`}
            // Hover syncs the keyboard highlight to the mouse so both share one active row.
            onMouseEnter={() => onHover(i)}
            // onMouseDown (not onClick): the input's onBlur would close the dropdown before a
            // click registers; mousedown fires first, and we preventDefault to keep focus.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(s.query);
            }}
          >
            <span className="dropdown__query">{s.query}</span>
            {/* The score column makes the basic-vs-recency difference visible: in basic mode
                this is the raw all-time count; in recency mode it's the blended score. */}
            <span className="dropdown__score">{formatScore(s.score)}</span>
          </li>
        ))}
      </ul>

      {/* Footer shows where the result came from — concrete evidence of the cache + ring for
          the viva (HIT served by a specific Redis node vs MISS rebuilt from the trie). Only
          meaningful for cache/trie; "empty" never reaches here (no list is rendered for it). */}
      {(source === "cache" || source === "trie") && (
        <div className="dropdown__meta">
          <span>
            source:{" "}
            <span className={`badge ${source === "cache" ? "badge--cache" : "badge--trie"}`}>
              {source === "cache" ? "CACHE HIT" : "TRIE (miss)"}
            </span>
          </span>
          {node && <span className="dropdown__node">node: {node}</span>}
        </div>
      )}
    </div>
  );
}

/** Compact score formatting (e.g. 85000 → "85,000"; recency scores keep one decimal). */
function formatScore(score: number): string {
  return Number.isInteger(score)
    ? score.toLocaleString()
    : score.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
