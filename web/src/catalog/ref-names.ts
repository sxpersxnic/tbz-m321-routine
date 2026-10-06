/**
 * Names of the task lists and routines an event trigger's filter points at – so a tile says
 * "When a task in Work is completed", not an id. Loaded once for all tiles, again after 30 s.
 */
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { NameOf } from '../lib/event-trigger.ts';

interface Names {
  lists: Map<string, string>;
  routines: Map<string, string>;
}

const FRESH_MS = 30_000;
let cached: { at: number; names: Promise<Names> } | undefined;

function load(): Promise<Names> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.names;
  const names = Promise.all([api.taskLists().catch(() => []), api.routines().catch(() => [])]).then(([lists, routines]) => ({
    lists: new Map(lists.map((list) => [list.id, list.name])),
    routines: new Map(routines.map((routine) => [routine.id, routine.name])),
  }));
  cached = { at: Date.now(), names };
  return names;
}

/**
 * The names, once loaded – only fetched when `needed` (a routine with an event trigger).
 *
 * @example const nameOf = useRefNames(routine.trigger.type === 'event'); describeTrigger(routine.trigger, catalog, nameOf)
 */
export function useRefNames(needed: boolean): NameOf {
  const [names, setNames] = useState<Names>();
  useEffect(() => {
    if (!needed) return;
    let live = true;
    void load().then((loaded) => {
      if (live) setNames(loaded);
    });
    return () => {
      live = false;
    };
  }, [needed]);
  return (picker, id) => (picker === 'tasklist' ? names?.lists.get(id) : names?.routines.get(id));
}
