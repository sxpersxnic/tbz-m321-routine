import { useState } from 'react';
import { api } from '../api.ts';
import { useToast } from '../components/toast.tsx';
import { Empty, ErrorNote, Icon, IconButton, Modal, Skeleton } from '../components/ui.tsx';
import { dateTime, groupByDay, relative } from '../format.ts';
import { useNow, usePolling } from '../hooks.ts';
import type { Notification, Priority } from '../types.ts';

const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High' };
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

type Status = 'all' | 'unread' | 'read';
type Sort = 'newest' | 'oldest' | 'priority';

const STATUS_LABEL: Record<Status, string> = { all: 'All', unread: 'Unread', read: 'Read' };
const SORTS: Record<Sort, string> = { newest: 'Newest first', oldest: 'Oldest first', priority: 'By priority' };

export function Notifications({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const now = useNow(10_000);
  const [status, setStatus] = useState<Status>('all');
  const [priority, setPriority] = useState<Priority | 'all'>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const notifications = usePolling(() => api.notifications(), 3000);
  const all = notifications.data ?? [];
  const unread = all.filter((notification) => !notification.readAt);

  const term = search.trim().toLowerCase();
  const visible = all
    .filter((notification) => {
      if (status === 'unread' && notification.readAt) return false;
      if (status === 'read' && !notification.readAt) return false;
      if (priority !== 'all' && notification.priority !== priority) return false;
      return !term || `${notification.title} ${notification.body}`.toLowerCase().includes(term);
    })
    .sort((a, b) => {
      if (sort === 'priority') return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.createdAt.localeCompare(a.createdAt);
      return sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt);
    });
  // by priority the day is secondary – the heading says the priority instead
  const groups = sort === 'priority'
    ? (['high', 'normal', 'low'] as const)
        .map((level) => ({ label: `${PRIORITY_LABEL[level]} priority`, items: visible.filter((notification) => notification.priority === level) }))
        .filter((group) => group.items.length > 0)
    : groupByDay(visible, (notification) => notification.createdAt);
  const filtered = status !== 'all' || priority !== 'all' || term !== '';
  const resetFilters = () => { setStatus('all'); setPriority('all'); setSearch(''); };
  const counts: Record<Status, number> = { all: all.length, unread: unread.length, read: all.length - unread.length };

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
        <div className="inbox-controls">
          <div className="search wide">
            <Icon name="search" size={16} />
            <input type="search" value={search} placeholder="Search" aria-label="Search notifications" onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="filter-bar">
            <div className="segmented" role="tablist" aria-label="Status">
              {(['all', 'unread', 'read'] as const).map((key) => (
                <button key={key} type="button" role="tab" aria-selected={status === key} className={status === key ? 'active' : ''} onClick={() => setStatus(key)}>
                  {STATUS_LABEL[key]} <span className="seg-count">{counts[key]}</span>
                </button>
              ))}
            </div>
            <div className="filter-selects">
              <select className="compact-select" value={priority} aria-label="Priority" onChange={(event) => setPriority(event.target.value as Priority | 'all')}>
                <option value="all">Any priority</option>
                {(['high', 'normal', 'low'] as const).map((level) => <option key={level} value={level}>{PRIORITY_LABEL[level]}</option>)}
              </select>
              <select className="compact-select" value={sort} aria-label="Sort" onChange={(event) => setSort(event.target.value as Sort)}>
                {Object.entries(SORTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      <ErrorNote error={notifications.error} onRetry={notifications.reload} />
      {notifications.loading ? <div className="card"><Skeleton lines={4} /></div> : all.length === 0 ? (
        <div className="card">
          <Empty icon="bell" title="No notifications" />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          {status === 'unread' && priority === 'all' && !term
            ? <Empty icon="check" title="All caught up" action={<button type="button" className="btn" onClick={resetFilters}>Show all</button>} />
            : <Empty icon="search" title="No matching notification" action={<button type="button" className="btn" onClick={resetFilters}>Reset filters</button>} />}
        </div>
      ) : (
        <>
          {filtered && <p className="inbox-count" aria-live="polite">{visible.length} of {all.length}</p>}
          {groups.map((group, index) => (
            <section key={group.label} aria-labelledby={`notice-group-${index}`}>
              <h2 id={`notice-group-${index}`} className="group-label">{group.label}</h2>
              <ul className="notice-list">{group.items.map(card)}</ul>
            </section>
          ))}
        </>
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
