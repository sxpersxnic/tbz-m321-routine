import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { connectionStore, sessionStore } from './api.ts';

// ---------------------------------------------------------------- session

export const useSession = () => useSyncExternalStore(sessionStore.subscribe, sessionStore.get);

/** False while the backend is unreachable – the shell warns that shown data may be stale. */
export const useReachable = () => useSyncExternalStore(connectionStore.subscribe, connectionStore.get);

// ---------------------------------------------------------------- hash router

function currentPath() {
  return window.location.hash.replace(/^#/, '') || '/';
}

/** The full route including its `?query` part. */
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

/**
 * A filter kept in the URL instead of component state, so reloading, sharing or
 * going back keeps the view the user had set up.
 */
export function useRouteParam(name: string): [string | null, (value: string | null) => void] {
  const route = useRoute();
  const [path, query = ''] = route.split('?');
  const value = new URLSearchParams(query).get(name);
  const set = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(query);
      if (next) params.set(name, next);
      else params.delete(name);
      const suffix = params.toString();
      navigate(suffix ? `${path}?${suffix}` : path);
    },
    [name, path, query],
  );
  return [value, set];
}

/** Warns before a reload or tab close would throw away unsaved edits. */
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
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
  /** Optimistic update: shows the expected result now, the next poll confirms or corrects it. */
  mutate: (update: (current: T) => T) => void;
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
  // A ref, not `data`: the effect's closure would keep seeing the initial undefined.
  const loadedRef = useRef(false);
  // bumped by mutate(): a poll that started before an optimistic change carries stale data
  const generation = useRef(0);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      // Hidden tabs only load once (so a page opened in the background has data), then pause.
      if (document.visibilityState === 'visible' || !loadedRef.current) {
        const startedAt = generation.current;
        try {
          const result = await loadRef.current();
          if (!cancelled && startedAt === generation.current) {
            loadedRef.current = true;
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

  const mutate = useCallback((update: (current: T) => T) => {
    generation.current += 1;
    setData((current) => (current === undefined ? current : update(current)));
  }, []);

  return { data, error, loading, reload, mutate };
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
