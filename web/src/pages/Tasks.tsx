import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { useToast } from '../components/toast.tsx';
import { Empty, ErrorNote, Icon, Modal, Skeleton } from '../components/ui.tsx';
import { date } from '../format.ts';
import { usePolling } from '../hooks.ts';
import type { Priority, Task } from '../types.ts';

const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High' };

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
  const [creating, setCreating] = useState(false);
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
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} /> New task
        </button>
      </header>

      <TaskDialog open={creating} defaultDue={list === 'today' ? today : ''} onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); tasks.reload(); }} />

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
          </>
        )}
      </section>
    </div>
  );
}

/** New task in a dialog – title first, everything else optional. */
function TaskDialog({ open, defaultDue, onClose, onCreated }: {
  open: boolean;
  /** Pre-filled due date, e.g. today when creating from the "Today" list. */
  defaultDue: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  // every opening starts empty
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setPriority('normal');
    setDueDate(defaultDue);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      const created = await api.createTask({
        title: title.trim(),
        priority,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(dueDate ? { dueDate } : {}),
      });
      toast(`"${created.title}" added`);
      onCreated();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="New task" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label className="field">
          <span>Title</span>
          <input type="text" required maxLength={200} value={title} autoFocus onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea rows={3} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="form-row">
          <div className="field">
            <span id="task-priority-label">Priority</span>
            <div className="segmented" role="radiogroup" aria-labelledby="task-priority-label">
              {Object.entries(PRIORITY_LABEL).map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={priority === value}
                  className={priority === value ? 'active' : ''} onClick={() => setPriority(value as Priority)}>{label}</button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Due</span>
            <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!title.trim() || saving}>Add task</button>
        </div>
      </form>
    </Modal>
  );
}
