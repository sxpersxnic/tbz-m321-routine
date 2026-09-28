/** The inbox: storing notifications (with their event) and the notification.send capability. */
import { randomUUID } from 'node:crypto';
import { emitEvent, type CapabilityHandler, type HandlerTools, type Logger, type Queryable } from '@routine/service-kit';
import { sendDraft, SOURCE, type NotificationDraft } from './messages.ts';

export interface NotificationRow {
  id: string;
  owner_id: string;
  title: string;
  body: string;
  priority: string;
  category: string;
  execution_id: string | null;
  created_at: Date;
  read_at: Date | null;
  resolved_at: Date | null;
}

/**
 * Stores (= delivers to the inbox) exactly once per source message, with its notification.created
 * event in the same transaction – delivery-service (M8) turns it into push, e-mail and chat.
 */
export async function deliver(
  db: Queryable,
  draft: NotificationDraft,
  // a routine step passes the kit's emit, which adds `origin` (and stays silent in test mode)
  emit: Emit = (type, data) => emitEvent(db, SOURCE, type, data),
): Promise<{ row: NotificationRow; created: boolean }> {
  const inserted = await db.query<NotificationRow>(
    `INSERT INTO notifications (id, owner_id, title, body, priority, category, source_key, execution_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source_key) DO NOTHING RETURNING *`,
    [randomUUID(), draft.ownerId, draft.title, draft.body, draft.priority, draft.category, draft.sourceKey, draft.executionId],
  );
  const row = inserted.rows[0];
  if (row) {
    await emit('notification.created', {
      ownerId: row.owner_id,
      notificationId: row.id,
      title: row.title,
      body: row.body,
      priority: row.priority,
      kind: 'info',
      options: null,
      routineId: draft.routineId ?? null,
      executionId: row.execution_id,
    });
    return { row, created: true };
  }
  const existing = await db.query<NotificationRow>('SELECT * FROM notifications WHERE source_key = $1', [draft.sourceKey]);
  return { row: existing.rows[0], created: false };
}

type Emit = HandlerTools['emit'];

export function notificationHandlers(logger: Logger): Record<string, CapabilityHandler> {
  return {
    'notification.send': async (command, { tx, emit }) => {
      const { row, created } = await deliver(tx, sendDraft(command), emit);
      if (created) logger.info({ notificationId: row.id, title: row.title }, 'notification delivered');
      return { kind: 'completed', output: { notificationId: row.id, channel: 'inbox', deliveredAt: row.created_at } };
    },
  };
}
