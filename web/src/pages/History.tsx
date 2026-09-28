import { useState } from 'react';
import { api } from '../api.ts';
import { useToast } from '../components/toast.tsx';
import { ErrorNote, Icon, Skeleton } from '../components/ui.tsx';
import { dateTime, relative } from '../format.ts';
import { usePolling, useNow, useRouteParam } from '../hooks.ts';
import { describeChanges, restoredFrom } from '../lib/diff.ts';
import type { RoutineVersion } from '../types.ts';

/** Two definitions are the same routine when everything but "on/off" matches. */
const sameRoutine = (a: RoutineVersion, b: RoutineVersion) => {
  const { active: _a, ...left } = a.definition;
  const { active: _b, ...right } = b.definition;
  return JSON.stringify(left) === JSON.stringify(right);
};

/**
 * Every version of a routine, newest first, each with what changed in words (02-experience §5).
 * Restore saves an old definition as the next version – history is never rewritten.
 */
export function History({ id }: { id: string }) {
  const toast = useToast();
  const now = useNow(30_000);
  const [highlight] = useRouteParam('version');
  const [restoring, setRestoring] = useState<number>();
  const routine = usePolling(() => api.routine(id), 0, [id]);
  const versions = usePolling(() => api.routineVersions(id), 0, [id]);

  async function restore(version: number) {
    setRestoring(version);
    try {
      await api.restoreVersion(id, version);
      toast(`Restored version ${version}`);
      versions.reload();
      routine.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setRestoring(undefined);
    }
  }

  const items = versions.data ?? [];
  const current = items[0];

  return (
    <div className="page">
      <a className="back" href={`#/routines/${id}`}><Icon name="back" size={18} /> {routine.data?.name ?? 'Routine'}</a>
      <header className="page-head">
        <div><h1>History</h1></div>
      </header>
      <ErrorNote error={versions.error ?? routine.error} onRetry={versions.reload} />
      {versions.loading ? <div className="card"><Skeleton lines={4} /></div> : (
        <ol className="history">
          {items.map((version, index) => {
            const previous = items[index + 1]?.definition ?? null;
            const from = version.origin === 'restore' ? restoredFrom(items, index) : undefined;
            const changes = describeChanges(previous, version.definition, version.origin);
            const lines = [
              ...(version.origin === 'restore' ? [from ? `Restored version ${from}` : 'Restored an earlier version'] : []),
              ...changes,
              ...(version.origin === 'backfill' && !previous ? ['History starts here'] : []),
            ];
            return (
              <li key={version.version} className={`history-entry ${String(version.version) === highlight ? 'highlight' : ''}`}
                aria-current={index === 0 ? 'true' : undefined}>
                <div className="history-head">
                  <strong>Version {version.version}</strong>
                  <span className="muted small" title={dateTime(version.createdAt)}>{relative(version.createdAt, now)}</span>
                  <span className="grow" />
                  {index === 0 ? <span className="chip">Current</span> : current && !sameRoutine(version, current) && (
                    <button type="button" className="btn small" disabled={restoring !== undefined} onClick={() => void restore(version.version)}>
                      {restoring === version.version ? <span className="spinner" /> : <Icon name="history" size={14} />} Restore
                    </button>
                  )}
                </div>
                {lines.length > 0 && <ul className="history-changes">{lines.map((line) => <li key={line}>{line}</li>)}</ul>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
