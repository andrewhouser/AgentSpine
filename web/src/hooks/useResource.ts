/**
 * Load something from the API, and reload it on demand.
 *
 * Every view here does the same thing — fetch on mount, refetch after a mutation — and
 * doing it by hand means each one re-derives the same two subtleties: a response from a
 * superseded request must not overwrite a newer one, and the fetch has to live inside the
 * effect rather than in a callback the effect invokes (otherwise a refetch closes over a
 * stale render and the linter is right to object).
 *
 * `load` is held in a ref, so passing an inline arrow doesn't retrigger the fetch on every
 * render. Reloading is explicit: bump the key, the effect runs again.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const useResource = <T>(load: () => Promise<T>, initial: T): [T, () => void] => {
  const [data, setData] = useState<T>(initial);
  const [key, setKey] = useState(0);
  const loadRef = useRef(load);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      const value = await loadRef.current();
      if (!cancelled) setData(value);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [key]);

  return [data, useCallback(() => setKey((k) => k + 1), [])];
};
