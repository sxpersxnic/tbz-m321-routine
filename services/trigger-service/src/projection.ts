/**
 * The subscriptions projection (trigger-service.md §3–4): which routines start on which event, kept
 * from RoutineSaved / RoutineDeleted and rebuilt from routine-service on demand. Messages may arrive
 * out of order and twice – the routine version decides: an older version never overwrites a newer one,
 * and a routine that stopped starting on an event keeps a tombstone (a row without event type).
 */
import { withTransaction, type Pool, type Queryable } from '@routine/service-kit';
import type { RoutineMessage, RoutineState } from './messages.ts';

/** What became of a routine message: stored, removed, or ignored because a newer version is known. */
export type ProjectionOutcome = 'stored' | 'removed' | 'stale';

/** RoutineDeleted carries no version: the tombstone of a deleted routine outranks every save. */
const DELETED_VERSION = 2_147_483_647;

/** Upserts a row unless a newer version is stored; `event: null` writes a tombstone. Returns whether it wrote. */
async function store(db: Queryable, routine: RoutineState): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO subscriptions (routine_id, owner_id, event_type, filter, routine_version, active, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (routine_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id, event_type = EXCLUDED.event_type, filter = EXCLUDED.filter,
           routine_version = EXCLUDED.routine_version, active = EXCLUDED.active, updated_at = now()
       WHERE subscriptions.routine_version <= EXCLUDED.routine_version`,
    [routine.routineId, routine.ownerId, routine.event?.type ?? null, JSON.stringify(routine.event?.filter ?? []), routine.version, routine.event ? routine.active : false],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Applies one routine state with the version rule: an event trigger is stored (or updated), any
 * other trigger turns the row into a tombstone – unless a newer version is already stored.
 *
 * @example await applyRoutineState(pool, { routineId, ownerId, version: 4, active: true, event: { type: 'task.completed', filter: [] } }) // → 'stored'
 */
export async function applyRoutineState(db: Queryable, routine: RoutineState): Promise<ProjectionOutcome> {
  if (!(await store(db, routine))) return 'stale';
  return routine.event ? 'stored' : 'removed';
}

/**
 * Applies RoutineSaved / RoutineDeleted. A delete leaves a tombstone that no save outranks.
 *
 * @example await applyRoutineMessage(pool, parseRoutineMessage(envelope))
 */
export async function applyRoutineMessage(db: Queryable, message: RoutineMessage): Promise<ProjectionOutcome> {
  if (message.kind === 'saved') return applyRoutineState(db, message.routine);
  await store(db, { routineId: message.routineId, ownerId: message.ownerId, version: DELETED_VERSION, active: false, event: null });
  return 'removed';
}

/** Whether the projection holds nothing – then it is rebuilt on startup. */
export async function projectionEmpty(db: Queryable): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM subscriptions LIMIT 1');
  return !rowCount;
}

/**
 * Rebuilds the projection from routine-service's list of event-triggered routines. Applied with the
 * version rule, so a RoutineSaved consumed while the list was on its way is not undone; rows the list
 * no longer has are removed unless they changed after the list was asked for.
 *
 * @example await resync(pool, () => routines.eventRoutines()) // → { stored: 12, removed: 1 }
 */
export async function resync(pool: Pool, list: () => Promise<RoutineState[]>): Promise<{ stored: number; removed: number }> {
  const { rows } = await pool.query<{ now: Date }>('SELECT now() AS now');
  const askedAt = rows[0].now;
  const routines = await list();
  return withTransaction(pool, async (tx) => {
    let stored = 0;
    for (const routine of routines) if ((await applyRoutineState(tx, routine)) === 'stored') stored++;
    // what the list no longer has goes – subscriptions and old tombstones alike
    const { rowCount } = await tx.query('DELETE FROM subscriptions WHERE NOT (routine_id = ANY($1::uuid[])) AND updated_at < $2', [
      routines.map((routine) => routine.routineId),
      askedAt,
    ]);
    return { stored, removed: rowCount ?? 0 };
  });
}
