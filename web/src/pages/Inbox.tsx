import { useState } from 'react';
import { api } from '../api.ts';
import { useToast } from '../components/toast.tsx';
import { Empty, ErrorNote, Icon, IconButton, Modal, Skeleton } from '../components/ui.tsx';
import { dateTime, groupByDay, relative } from '../format.ts';
import { useNow, usePolling } from '../hooks.ts';
import type { Notification, Priority } from '../types.ts';

const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High' };

// ---------------------------------------------------------------- notifications

export function Notifications({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const now = useNow(10_000);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const notifications = usePolling(() => api.notifications(), 3000);
  const all = notifications.data ?? [];
  const unread = all.filter((notification) => !notification.readAt);
  const visible = onlyUnread ? unread : all;

  async function markRead(ids: string[]) {
    const now = new Date().toISOString();
    notifications.mutate((items) => items.map((item) => (ids.includes(item.id) ? { ...item, readAt: item.readAt ?? now } : item)));
    try {
      await Promise.all(ids.map((id) => api.markRead(id)));
      onChange();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      notifications.reload();
    }
  }

  // Opening a notification only shows it – reading is marked on purpose, with the tick button.
  const card = (notification: Notification) => {
    const read = Boolean(notification.readAt);
    return (
      <li key={notification.id} className={`notice ${read ? 'read' : ''} prio-${notification.priority}`}>
        {!read && <span className="unread-dot" aria-hidden="true" />}
        <span className="glyph tint-pink" aria-hidden="true"><Icon name="bell" size={20} /></span>
        <button type="button" className="notice-main grow" onClick={() => setOpenId(notification.id)} aria-haspopup="dialog">
          <span className="notice-top">
            <span className="notice-title">
              {!read && <span className="sr-only">Unread: </span>}
              {notification.title}
            </span>
            <span className="notice-time">{relative(notification.createdAt, now)}</span>
          </span>
          {notification.body && <span className="notice-body">{notification.body}</span>}
        </button>
        {!read && (
          <span className="notice-side">
            <IconButton icon="check" label={`Mark "${notification.title}" as read`} onClick={() => void markRead([notification.id])} />
          </span>
        )}
      </li>
    );
  };
  const opened = all.find((notification) => notification.id === openId);

  return (
    <div className="page narrow-page">
      <header className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="lede">{unread.length > 0 ? `${unread.length} unread` : 'All caught up'}</p>
        </div>
        <button type="button" className="btn tinted" disabled={unread.length === 0}
          onClick={() => void markRead(unread.map((notification) => notification.id))}>
          Mark all read
        </button>
      </header>

      {all.length > 0 && (
        <div className="segmented" role="tablist" aria-label="Filter">
          <button type="button" role="tab" aria-selected={!onlyUnread} className={onlyUnread ? '' : 'active'} onClick={() => setOnlyUnread(false)}>
            All <span className="seg-count">{all.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={onlyUnread} className={onlyUnread ? 'active' : ''} onClick={() => setOnlyUnread(true)}>
            Unread <span className="seg-count">{unread.length}</span>
          </button>
        </div>
      )}

      <ErrorNote error={notifications.error} onRetry={notifications.reload} />
      {notifications.loading ? <div className="card"><Skeleton lines={4} /></div> : all.length === 0 ? (
        <div className="card">
          <Empty icon="bell" title="No notifications" />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <Empty icon="check" title="All caught up" action={<button type="button" className="btn" onClick={() => setOnlyUnread(false)}>Show all</button>} />
        </div>
      ) : (
        groupByDay(visible, (notification) => notification.createdAt).map((group, index) => (
          <section key={group.label} aria-labelledby={`notice-day-${index}`}>
            <h2 id={`notice-day-${index}`} className="group-label">{group.label}</h2>
            <ul className="notice-list">{group.items.map(card)}</ul>
          </section>
        ))
      )}

      <Modal open={Boolean(opened)} title={opened?.title ?? ''} wide onClose={() => setOpenId(null)}
        headerAction={opened && !opened.readAt
          ? <IconButton icon="check" label="Mark as read" onClick={() => void markRead([opened.id])} />
          : undefined}
        actions={<button type="button" className="btn" onClick={() => setOpenId(null)}>Close</button>}>
        {opened && (
          <>
            <p className="notice-detail-meta">
              <span>{dateTime(opened.createdAt)}</span>
              {opened.priority !== 'normal' && <span>{PRIORITY_LABEL[opened.priority]} priority</span>}
              <span>{opened.readAt ? `Read ${relative(opened.readAt, now)}` : 'Unread'}</span>
            </p>
            {opened.body ? <p className="notice-detail-body">{opened.body}</p> : <p>No message.</p>}
          </>
        )}
      </Modal>
    </div>
  );
}
