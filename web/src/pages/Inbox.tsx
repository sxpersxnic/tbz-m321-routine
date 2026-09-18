import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { useToast } from '../components/toast.tsx';
import { Empty, ErrorNote, Icon, Skeleton } from '../components/ui.tsx';
import { date, groupByDay, relative } from '../format.ts';
import { useNow, usePolling } from '../hooks.ts';
import type { Notification, Priority, Task } from '../types.ts';

const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High' };

// ---------------------------------------------------------------- tasks

type ListKey = 'today' | 'scheduled' | 'open' | 'done';

/** Reminders' smart lists: the questions people actually ask of a task list. */
const LISTS: Array<{ key: ListKey; label: string; icon: string; tint: string }> = [
  { key: 'today', label: 'Today', icon: 'calendar', tint: 'sky' },
  { key: 'scheduled', label: 'Scheduled', icon: 'clock', tint: 'pink' },
  { key: 'open', label: 'Open', icon: 'checklist', tint: 'grey' },
  { key: 'done', label: 'Done', icon: 'check', tint: 'green' },
];

const isoDay = (offset = 0) => {
  const day = new Date();
  day.setDate(day.getDate() + offset);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
};

function dueText(task: Task, today: string, tomorrow: string): { text: string; tone?: 'overdue' | 'today' } | null {
  if (!task.dueDate) return null;
  if (task.status === 'OPEN' && task.dueDate < today) return { text: `Overdue since ${date(task.dueDate)}`, tone: 'overdue' };
  if (task.dueDate === today) return { text: 'Today', tone: 'today' };
  if (task.dueDate === tomorrow) return { text: 'Tomorrow' };
  return { text: date(task.dueDate) };
}

export function Tasks() {
  const toast = useToast();
  const [list, setList] = useState<ListKey>('open');
  const tasks = usePolling(() => api.tasks(), 3000);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [dueDate, setDueDate] = useState('');
  // just-ticked tasks linger in open lists for a moment, struck through, instead of vanishing under the cursor
  const [lingering, setLingering] = useState<Set<string>>(new Set());

  const today = isoDay();
  const tomorrow = isoDay(1);
  const all = tasks.data ?? [];
  const open = all.filter((task) => task.status === 'OPEN' || lingering.has(task.id));
  const members: Record<ListKey, Task[]> = {
    today: open.filter((task) => task.dueDate && task.dueDate <= today),
    scheduled: open.filter((task) => task.dueDate),
    open,
    done: all.filter((task) => task.status === 'DONE').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
  };
  const overdue = open.filter((task) => task.dueDate && task.dueDate < today).length;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    const due = dueDate || (list === 'today' ? today : '');
    try {
      const created = await api.createTask({ title: title.trim(), priority, ...(due ? { dueDate: due } : {}) });
      toast(`"${created.title}" added`);
      setTitle('');
      setDueDate('');
      setPriority('normal');
      tasks.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  // Ticked at once, like a paper list; the server call follows and a failure undoes it.
  async function toggle(task: Task) {
    const status = task.status === 'DONE' ? 'OPEN' : 'DONE';
    const set = (next: Task['status']) => tasks.mutate((items) => items.map((item) => (item.id === task.id ? { ...item, status: next, completedAt: next === 'DONE' ? new Date().toISOString() : null } : item)));
    set(status);
    if (status === 'DONE') {
      setLingering((current) => new Set(current).add(task.id));
      setTimeout(() => setLingering((current) => { const next = new Set(current); next.delete(task.id); return next; }), 1500);
    }
    try {
      await api.setTaskStatus(task.id, status);
      tasks.reload();
    } catch (error) {
      set(task.status);
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  // Grouped like Reminders' "Scheduled": the heading carries the date, rows stay short.
  const visible = members[list];
  const groups: Array<{ label: string; items: Task[] }> = list === 'done' ? [{ label: '', items: visible }] : [
    { label: 'Overdue', items: visible.filter((task) => task.dueDate && task.dueDate < today) },
    { label: 'Today', items: visible.filter((task) => task.dueDate === today) },
    { label: 'Tomorrow', items: visible.filter((task) => task.dueDate === tomorrow) },
    { label: 'Later', items: visible.filter((task) => task.dueDate && task.dueDate > tomorrow).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')) },
    { label: 'No date', items: visible.filter((task) => !task.dueDate) },
  ].filter((group) => group.items.length > 0);
  const current = LISTS.find((item) => item.key === list) ?? LISTS[2];

  const row = (task: Task) => {
    const due = dueText(task, today, tomorrow);
    const done = task.status === 'DONE';
    return (
      <li key={task.id} className={`task-row ${done ? 'done' : ''}`}>
        <input type="checkbox" className={`task-check prio-${task.priority}`} checked={done}
          onChange={() => void toggle(task)} aria-label={`${task.title} ${done ? 'reopen' : 'complete'}`} />
        <div className="task-body">
          <span className="task-title">
            {task.priority === 'high' && <span className="prio-mark" title="High priority">!!<span className="sr-only"> High priority:</span></span>}
            {task.title}
          </span>
          {task.description && <span className="muted small block">{task.description}</span>}
          {due && <span className="task-meta"><span className={due.tone}>{due.text}</span></span>}
        </div>
        {/* the source is a quiet icon – a sentence on every row drowned the titles */}
        {task.sourceExecutionId && (
          <a className="task-source" href={`#/executions/${task.sourceExecutionId}`} title="Created by a routine – view run" aria-label={`${task.title}: view run`}>
            <Icon name="routines" size={15} />
          </a>
        )}
      </li>
    );
  };

  return (
    <div className="page narrow-page">
      <header className="page-head">
        <div>
          <h1>Tasks</h1>
        </div>
      </header>

      <div className="smart-lists" role="group" aria-label="Lists">
        {LISTS.map((item) => (
          <button key={item.key} type="button" className={`smart-list tint-${item.tint}`} aria-pressed={list === item.key} onClick={() => setList(item.key)}>
            <span className="smart-list-top">
              <span className={`glyph tint-${item.tint}`} aria-hidden="true"><Icon name={item.icon} size={17} /></span>
              <span className="smart-list-count">{tasks.data ? members[item.key].length : '–'}</span>
            </span>
            <span className="smart-list-name">
              {item.label}
              {item.key === 'today' && overdue > 0 && <span className="sr-only">, {overdue} overdue</span>}
            </span>
          </button>
        ))}
      </div>

      <ErrorNote error={tasks.error} onRetry={tasks.reload} />

      <section aria-labelledby="task-list-title" className="section">
        <h2 id="task-list-title" className={`tint-text-${current.tint}`} style={{ fontSize: 26 }}>{current.label}</h2>

        {tasks.loading ? <div className="card"><Skeleton lines={4} /></div> : (
          <>
            {groups.length === 0 && (
              <div className="card">
                <Empty icon={list === 'done' ? 'checklist' : 'check'}
                  title={list === 'done' ? 'Nothing done yet' : list === 'today' ? 'All done for today' : 'No tasks'} />
              </div>
            )}
            {groups.map((group) => (
              <div key={group.label || 'all'}>
                {group.label && <h3 className="group-label">{group.label}</h3>}
                <ul className="list">{group.items.map(row)}</ul>
              </div>
            ))}
            {list !== 'done' && (
              <form className="list quick-add" onSubmit={create}>
                <span className="plus" aria-hidden="true"><Icon name="plus" size={14} /></span>
                <input type="text" placeholder="New task" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} aria-label="New task title" />
                <select value={priority} onChange={(event) => setPriority(event.target.value as Priority)} aria-label="Priority">
                  {Object.entries(PRIORITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} aria-label="Due date" />
                <button type="submit" className="btn primary small" disabled={!title.trim()}>Add</button>
              </form>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- notifications

export function Notifications({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const now = useNow(10_000);
  const [onlyUnread, setOnlyUnread] = useState(false);
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

  const card = (notification: Notification) => {
    const read = Boolean(notification.readAt);
    const body = (
      <>
        <span className="notice-top">
          <span className="notice-title">
            {!read && <span className="sr-only">Unread: </span>}
            {notification.title}
          </span>
          <span className="notice-time">{relative(notification.createdAt, now)}</span>
        </span>
        {notification.body && <span className="notice-body">{notification.body}</span>}
      </>
    );
    return (
      <li key={notification.id} className={`notice ${read ? 'read' : ''} prio-${notification.priority}`}>
        {!read && <span className="unread-dot" aria-hidden="true" />}
        <span className="glyph tint-pink" aria-hidden="true"><Icon name="bell" size={20} /></span>
        <div className="grow">
          {read
            ? <div className="notice-main">{body}</div>
            : <button type="button" className="notice-main" onClick={() => void markRead([notification.id])} title="Mark as read">{body}</button>}
        </div>
      </li>
    );
  };

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
    </div>
  );
}
