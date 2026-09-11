import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { sessionStore } from './api.ts';

// ---------------------------------------------------------------- session

export const useSession = () => useSyncExternalStore(sessionStore.subscribe, sessionStore.get);

// ---------------------------------------------------------------- hash router

function currentPath() {
  return window.location.hash.replace(/^#/, '') || '/';
}

export function useRoute(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

export function navigate(path: string) {
  window.location.hash = path;
}

/** Matches "/routines/:id/edit" style patterns; returns params or null. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('?')[0].split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of patternParts.entries()) {
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(pathParts[index]);
    else if (part !== pathParts[index]) return null;
  }
  return params;
}

// ---------------------------------------------------------------- polling

export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads data and refreshes it every `intervalMs` while the tab is visible.
 * Polling stops when `intervalMs` is 0 (e.g. an execution has finished).
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (document.visibilityState === 'visible' || data === undefined) {
        try {
          const result = await loadRef.current();
          if (!cancelled) {
            setData(result);
            setError(undefined);
          }
        } catch (caught) {
          if (!cancelled) setError(caught instanceof Error ? caught : new Error(String(caught)));
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
      if (!cancelled && intervalMs > 0) timer = setTimeout(run, intervalMs);
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  return { data, error, loading, reload };
}

/** Re-renders every `intervalMs` so relative times ("vor 5 s") stay current. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
