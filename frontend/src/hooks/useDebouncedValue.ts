import { useEffect, useState } from "react";

/**
 * useDebouncedValue — return `value` but only after it has stopped changing for `delayMs`.
 *
 * WHY debounce the typed prefix (spec §4.1): firing GET /suggest on EVERY keystroke would
 * send one backend request per character — for "iphone" that's 6 requests, 5 of them
 * instantly stale. Debouncing waits until the user pauses (~200ms) so we issue ONE request
 * for the settled prefix. This is the UI-side write-reduction the spec explicitly asks for
 * ("the UI should avoid unnecessary backend calls, for example by using debouncing").
 *
 * 200ms is the chosen interval: short enough to feel instant (well under the ~300ms a user
 * perceives as "responsive"), long enough that fast typing collapses into a single call.
 * It is a prop so the value/rationale lives in one place (App passes DEBOUNCE_MS).
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    // Schedule an update delayMs after the latest change.
    const timer = setTimeout(() => setDebounced(value), delayMs);
    // If `value` changes again before the timer fires, this cleanup cancels the pending
    // timer — so only a PAUSE in typing actually commits a new debounced value.
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
