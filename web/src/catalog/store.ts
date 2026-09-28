import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, sessionStore } from '../api.ts';
import type { CatalogDomain } from '../types.ts';
import { buildCatalog, type Catalog } from './catalog.ts';

/**
 * The catalog in the browser (docs/v2/07-web.md §4): loaded once after sign-in, revalidated when the
 * tab gets focus (If-None-Match → 304 while nothing changed), kept in localStorage per user so the
 * editor has it at once on the next visit.
 */
interface Cached {
  userId: string;
  etag: string | null;
  domains: CatalogDomain[];
}

const STORAGE_KEY = 'routine.catalog';
let state: Cached | null = restore();
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

function restore(): Cached | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null; // private mode or a broken entry – just load it
  }
}

function set(next: Cached | null) {
  state = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // not remembered – still works for this tab
  }
  for (const listener of listeners) listener();
}

/** Loads (or revalidates) the catalog of the signed-in user. */
export function refreshCatalog(userId = sessionStore.get()?.user.id): Promise<void> {
  if (!userId) return Promise.resolve();
  // another user's catalog is never shown – it may list domains this one hasn't got
  const current = state?.userId === userId ? state : null;
  loading ??= api
    .catalog(current?.etag ?? undefined)
    .then((result) => {
      if (result.status === 200) set({ userId, etag: result.etag, domains: result.domains });
    })
    .catch(() => undefined) // offline: keep what we have
    .finally(() => {
      loading = undefined;
    });
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The catalog, loading it on first use; `loaded` is false until there is one for this user. */
export function useCatalog(): Catalog & { loaded: boolean } {
  const cached = useSyncExternalStore(subscribe, () => state);
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.get);
  const userId = session?.user.id;
  useEffect(() => {
    void refreshCatalog(userId);
    const onFocus = () => void refreshCatalog(userId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [userId]);
  const mine = cached && cached.userId === userId ? cached.domains : [];
  return useMemo(() => ({ ...buildCatalog(mine), loaded: mine.length > 0 }), [mine]);
}
