import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { useToast } from '../components/toast.tsx';
import { Card, Empty, ErrorNote, Icon, Loading } from '../components/ui.tsx';
import { date, relative } from '../format.ts';
import { useNow, usePolling } from '../hooks.ts';
import type { Priority, Task } from '../types.ts';

const PRIORITY_LABEL: Record<Priority, string> = { low: 'niedrig', normal: 'normal', high: 'hoch' };

// ---------------------------------------------------------------- tasks

export function Tasks() {
  const toast = useToast();
  const [filter, setFilter] = useState<Task['status'] | undefined>('OPEN');
  const tasks = usePolling(() => api.tasks(filter), 3000, [filter]);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [dueDate, setDueDate] = useState('');

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      await api.createTask({ title, priority, ...(dueDate ? { dueDate } : {}) });
      setTitle('');
      setDueDate('');
      tasks.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function toggle(task: Task) {
    try {
      await api.setTaskStatus(task.id, task.status === 'DONE' ? 'OPEN' : 'DONE');
      tasks.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="page narrow-page">
      <header className="page-head">
        <div>
          <h1>Aufgaben</h1>
          <p className="muted">Verwaltet vom task-service – manuell oder durch Routinen erstellt.</p>
        </div>
      </header>
      <form className="card quick-add" onSubmit={create}>
        <input placeholder="Neue Aufgabe …" required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Titel" />
        <select value={priority} onChange={(event) => setPriority(event.target.value as Priority)} aria-label="Priorität">
          {Object.entries(PRIORITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} aria-label="Fällig am" />
        <button type="submit" className="btn primary"><Icon name="plus" size={16} /> Hinzufügen</button>
      </form>
      <div className="segmented">
        {([['OPEN', 'Offen'], ['DONE', 'Erledigt'], [undefined, 'Alle']] as const).map(([value, label]) => (
          <button key={label} type="button" className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>
        ))}
      </div>
      <ErrorNote error={tasks.error} />
      <Card>
        {tasks.loading ? <Loading /> : tasks.data?.length === 0 ? <Empty>Keine Aufgaben.</Empty> : (
          <ul className="task-list">
            {tasks.data?.map((task) => (
              <li key={task.id} className={task.status === 'DONE' ? 'done' : ''}>
                <label className="task-check">
                  <input type="checkbox" checked={task.status === 'DONE'} onChange={() => toggle(task)} />
                  <span className="grow">
                    <span className="task-title">{task.title}</span>
                    {task.description && <span className="muted small block">{task.description}</span>}
                  </span>
                </label>
                <span className={`chip prio-${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>
                <span className={`small ${task.status === 'OPEN' && task.dueDate && task.dueDate < today ? 'overdue' : 'muted'}`}>
                  {task.dueDate ? `fällig ${date(task.dueDate)}` : 'ohne Termin'}
                </span>
                {task.sourceExecutionId ? (
                  <a className="chip link-chip" href={`#/executions/${task.sourceExecutionId}`} title="Von einer Routine erstellt">⟳ Routine</a>
                ) : <span className="chip">manuell</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- notifications

export function Notifications({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const now = useNow(10_000);
  const notifications = usePolling(() => api.notifications(), 3000);
  const unread = notifications.data?.filter((notification) => !notification.readAt) ?? [];

  async function markRead(ids: string[]) {
    try {
      await Promise.all(ids.map((id) => api.markRead(id)));
      notifications.reload();
      onChange();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  return (
    <div className="page narrow-page">
      <header className="page-head">
        <div>
          <h1>Benachrichtigungen</h1>
          <p className="muted">Zugestellt vom notification-service – aus Aktionen und Ausführungs-Events.</p>
        </div>
        <button type="button" className="btn ghost" disabled={unread.length === 0} onClick={() => markRead(unread.map((notification) => notification.id))}>
          Alle als gelesen markieren
        </button>
      </header>
      <ErrorNote error={notifications.error} />
      {notifications.loading ? <Loading /> : notifications.data?.length === 0 ? <Card><Empty>Posteingang ist leer.</Empty></Card> : (
        <ul className="inbox">
          {notifications.data?.map((notification) => (
            <li key={notification.id} className={`${notification.readAt ? '' : 'unread'} prio-${notification.priority}`}>
              <button type="button" className="inbox-item" onClick={() => !notification.readAt && markRead([notification.id])}>
                <span className="inbox-icon" aria-hidden="true">{notification.category === 'execution' ? '⟳' : '✉'}</span>
                <span className="grow">
                  <span className="inbox-title">{notification.title}</span>
                  {notification.body && <span className="inbox-body">{notification.body}</span>}
                  <span className="muted small block">
                    {notification.category === 'execution' ? 'Ausführungs-Event' : 'Aktion notification.send'} · {relative(notification.createdAt, now)}
                  </span>
                </span>
              </button>
              {notification.executionId && <a className="link small" href={`#/executions/${notification.executionId}`}>Ausführung</a>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
