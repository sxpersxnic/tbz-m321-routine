import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { useToast } from '../components/toast.tsx';
import { ConfirmDialog, Empty, ErrorNote, Icon, Menu, Modal, Skeleton } from '../components/ui.tsx';
import { ColorPicker, IconPicker } from '../components/visual.tsx';
import { date } from '../format.ts';
import { usePolling } from '../hooks.ts';
import type { Priority, Task, TaskList, TaskListInput } from '../types.ts';

const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High' };

const DEFAULT_LIST_ICON = 'checklist';
const listIcon = (list: Pick<TaskList, 'icon'>) => list.icon ?? DEFAULT_LIST_ICON;

type SmartKey = 'today' | 'scheduled' | 'open' | 'done';

/** Reminders' smart lists: the questions people actually ask of a task list – across all lists. */
const SMART: Array<{ key: SmartKey; label: string; icon: string; tint: string }> = [
  { key: 'today', label: 'Today', icon: 'calendar', tint: 'sky' },
  { key: 'scheduled', label: 'Scheduled', icon: 'clock', tint: 'pink' },
  { key: 'open', label: 'Open', icon: 'checklist', tint: 'grey' },
  { key: 'done', label: 'Done', icon: 'check', tint: 'green' },
];

/** What the page shows: a smart list, or one of the user's own lists by id. */
type View = { smart: SmartKey } | { list: string };

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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function Tasks() {
  const toast = useToast();
  const [view, setView] = useState<View>({ smart: 'open' });
  const tasks = usePolling(() => api.tasks(), 3000);
  const lists = usePolling(() => api.taskLists(), 10_000);
  const [creating, setCreating] = useState(false);
  // null = closed, 'new' = create, a list = edit that list
  const [editingList, setEditingList] = useState<TaskList | 'new' | null>(null);
  const [deletingList, setDeletingList] = useState<TaskList | null>(null);
  // just-ticked tasks linger in open lists for a moment, struck through, instead of vanishing under the cursor
  const [lingering, setLingering] = useState<Set<string>>(new Set());

  const today = isoDay();
  const tomorrow = isoDay(1);
  const all = tasks.data ?? [];
  const allLists = lists.data ?? [];
  const listById = new Map(allLists.map((list) => [list.id, list]));
  const open = all.filter((task) => task.status === 'OPEN' || lingering.has(task.id));
  const smart: Record<SmartKey, Task[]> = {
    today: open.filter((task) => task.dueDate && task.dueDate <= today),
    scheduled: open.filter((task) => task.dueDate),
    open,
    done: all.filter((task) => task.status === 'DONE').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
  };
  const overdue = open.filter((task) => task.dueDate && task.dueDate < today).length;
  const openIn = (listId: string) => open.filter((task) => task.listId === listId);

  // a list deleted elsewhere (or just now) falls back to "Open"
  const currentList = 'list' in view ? listById.get(view.list) : undefined;
  useEffect(() => {
    if ('list' in view && lists.data && !currentList) setView({ smart: 'open' });
  }, [view, lists.data, currentList]);

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
      toast(message(error), 'error');
    }
  }

  async function removeList(list: TaskList) {
    setDeletingList(null);
    try {
      await api.deleteTaskList(list.id);
      toast(`"${list.name}" deleted`);
      setView({ smart: 'open' });
      lists.reload();
      tasks.reload();
    } catch (error) {
      toast(message(error), 'error');
    }
  }

  const smartKey = 'smart' in view ? view.smart : null;
  const visible = smartKey ? smart[smartKey] : currentList ? openIn(currentList.id) : [];
  // Grouped like Reminders' "Scheduled": the heading carries the date, rows stay short.
  const groups: Array<{ label: string; items: Task[] }> = smartKey === 'done' ? [{ label: '', items: visible }] : [
    { label: 'Overdue', items: visible.filter((task) => task.dueDate && task.dueDate < today) },
    { label: 'Today', items: visible.filter((task) => task.dueDate === today) },
    { label: 'Tomorrow', items: visible.filter((task) => task.dueDate === tomorrow) },
    { label: 'Later', items: visible.filter((task) => task.dueDate && task.dueDate > tomorrow).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')) },
    { label: 'No date', items: visible.filter((task) => !task.dueDate) },
  ].filter((group) => group.items.length > 0);
  const heading = smartKey
    ? { label: SMART.find((item) => item.key === smartKey)?.label ?? '', tint: SMART.find((item) => item.key === smartKey)?.tint ?? 'grey' }
    : { label: currentList?.name ?? '', tint: currentList?.color ?? 'grey' };
  // with a single list, naming it on every row says nothing
  const showListTag = smartKey !== null && allLists.length > 1;

  const row = (task: Task) => {
    const due = dueText(task, today, tomorrow);
    const done = task.status === 'DONE';
    const list = listById.get(task.listId);
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
          {(due || (showListTag && list)) && (
            <span className="task-meta">
              {due && <span className={due.tone}>{due.text}</span>}
              {showListTag && list && <span className={`list-tag tint-${list.color}`}><i aria-hidden="true" />{list.name}</span>}
            </span>
          )}
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

      <TaskDialog open={creating} lists={allLists}
        defaultList={currentList?.id ?? allLists.find((list) => list.isDefault)?.id ?? ''}
        defaultDue={smartKey === 'today' ? today : ''}
        onClose={() => setCreating(false)} onCreated={() => { setCreating(false); tasks.reload(); }} />
      <ListDialog list={editingList} onClose={() => setEditingList(null)}
        onSaved={(saved) => {
          setEditingList(null);
          // in the local data before the view switches – else the "list is gone" fallback fires first
          lists.mutate((items) => (items.some((item) => item.id === saved.id) ? items.map((item) => (item.id === saved.id ? saved : item)) : [...items, saved]));
          setView({ list: saved.id });
          lists.reload();
        }} />
      <ConfirmDialog open={deletingList !== null} title={`Delete "${deletingList?.name ?? ''}"?`} confirmLabel="Delete" danger
        onCancel={() => setDeletingList(null)} onConfirm={() => deletingList && void removeList(deletingList)}>
        <p>
          {(() => {
            const count = deletingList ? all.filter((task) => task.listId === deletingList.id).length : 0;
            return count === 0 ? 'The list is empty.' : `Its ${count === 1 ? 'task' : `${count} tasks`} will be deleted too.`;
          })()}
        </p>
      </ConfirmDialog>

      <div className="smart-lists" role="group" aria-label="Smart lists">
        {SMART.map((item) => (
          <button key={item.key} type="button" className={`smart-list tint-${item.tint}`} aria-pressed={smartKey === item.key} onClick={() => setView({ smart: item.key })}>
            <span className="smart-list-top">
              <span className={`glyph tint-${item.tint}`} aria-hidden="true"><Icon name={item.icon} size={17} /></span>
              <span className="smart-list-count">{tasks.data ? smart[item.key].length : '–'}</span>
            </span>
            <span className="smart-list-name">
              {item.label}
              {item.key === 'today' && overdue > 0 && <span className="sr-only">, {overdue} overdue</span>}
            </span>
          </button>
        ))}
      </div>

      <section aria-labelledby="my-lists-title" className="section">
        <div className="section-head">
          <h2 id="my-lists-title" className="group-label" style={{ margin: 0 }}>My lists</h2>
          <button type="button" className="btn ghost small" onClick={() => setEditingList('new')}>
            <Icon name="plus" size={14} /> Add list
          </button>
        </div>
        <ErrorNote error={lists.error} onRetry={lists.reload} />
        {lists.loading ? <div className="card"><Skeleton lines={2} /></div> : (
          <ul className="list" aria-label="My lists">
            {allLists.map((list) => (
              <li key={list.id}>
                <button type="button" className={`list-row task-list-row ${currentList?.id === list.id ? 'selected' : ''}`}
                  aria-pressed={currentList?.id === list.id} onClick={() => setView({ list: list.id })}>
                  <span className={`glyph tint-${list.color}`} aria-hidden="true"><Icon name={listIcon(list)} size={16} /></span>
                  <span className="grow">
                    <span className="row-title">{list.name}</span>
                    {list.description && <span className="row-sub">{list.description}</span>}
                  </span>
                  <span className="row-meta">{tasks.data ? openIn(list.id).length : '–'}<span className="sr-only"> open</span></span>
                  <span className="chev" aria-hidden="true"><Icon name="chevron" size={16} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ErrorNote error={tasks.error} onRetry={tasks.reload} />

      <section aria-labelledby="task-list-title" className="section">
        <div className="section-head">
          <div>
            <h2 id="task-list-title" className={`tint-text-${heading.tint}`} style={{ fontSize: 26 }}>{heading.label}</h2>
            {currentList?.description && <p>{currentList.description}</p>}
          </div>
          {currentList && (
            <Menu label={`${currentList.name}: list actions`} items={[
              { label: 'Edit list', icon: 'edit', onSelect: () => setEditingList(currentList) },
              ...(currentList.isDefault ? [] : [{ label: 'Delete list', icon: 'trash', onSelect: () => setDeletingList(currentList), danger: true }]),
            ]} />
          )}
        </div>

        {tasks.loading ? <div className="card"><Skeleton lines={4} /></div> : (
          <>
            {groups.length === 0 && (
              <div className="card">
                <Empty icon={smartKey === 'done' ? 'checklist' : 'check'}
                  title={smartKey === 'done' ? 'Nothing done yet' : smartKey === 'today' ? 'All done for today' : 'No open tasks'}
                  action={smartKey !== 'done'
                    ? <button type="button" className="btn" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New task</button>
                    : undefined} />
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
function TaskDialog({ open, lists, defaultList, defaultDue, onClose, onCreated }: {
  open: boolean;
  lists: TaskList[];
  /** Pre-selected list: the one being viewed, else the default list. */
  defaultList: string;
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
  const [listId, setListId] = useState('');
  const [saving, setSaving] = useState(false);

  // every opening starts empty
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setPriority('normal');
    setDueDate(defaultDue);
    setListId(defaultList);
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
        ...(listId ? { listId } : {}),
      });
      toast(`"${created.title}" added`);
      onCreated();
    } catch (error) {
      toast(message(error), 'error');
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="New task" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label className="field">
          <span>Title</span>
          <input type="text" required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
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
        {lists.length > 1 && (
          <label className="field">
            <span>List</span>
            <select value={listId} onChange={(event) => setListId(event.target.value)}>
              {lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
            </select>
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!title.trim() || saving}>Add task</button>
        </div>
      </form>
    </Modal>
  );
}

/** Create (`list === 'new'`) or edit a list: name, description, colour. */
function ListDialog({ list, onClose, onSaved }: {
  list: TaskList | 'new' | null;
  onClose: () => void;
  onSaved: (saved: TaskList) => void;
}) {
  const toast = useToast();
  const [input, setInput] = useState<TaskListInput>({ name: '', description: '', color: 'sky', icon: null });
  const [saving, setSaving] = useState(false);
  const open = list !== null;
  const existing = list !== null && list !== 'new' ? list : null;

  useEffect(() => {
    if (!open) return;
    setInput(existing
      ? { name: existing.name, description: existing.description, color: existing.color, icon: existing.icon }
      : { name: '', description: '', color: 'sky', icon: null });
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.name.trim()) return;
    setSaving(true);
    const body = { ...input, name: input.name.trim(), description: input.description.trim() };
    try {
      const saved = existing ? await api.updateTaskList(existing.id, body) : await api.createTaskList(body);
      toast(existing ? `"${saved.name}" saved` : `"${saved.name}" created`);
      onSaved(saved);
    } catch (error) {
      toast(message(error), 'error');
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title={existing ? 'Edit list' : 'New list'} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input type="text" required maxLength={60} value={input.name} onChange={(event) => setInput({ ...input, name: event.target.value })} />
        </label>
        <label className="field">
          <span>Description</span>
          <input type="text" maxLength={500} value={input.description} placeholder="Optional"
            onChange={(event) => setInput({ ...input, description: event.target.value })} />
        </label>
        <div className="list-look">
          <span className={`glyph list-look-preview tint-${input.color}`} aria-hidden="true"><Icon name={listIcon(input)} size={26} /></span>
          <div className="field grow">
            <span id="list-color-label">Colour</span>
            <ColorPicker labelledBy="list-color-label" value={input.color} onChange={(color) => setInput({ ...input, color: color ?? 'sky' })} />
          </div>
        </div>
        <div className="field">
          <span id="list-icon-label">Icon</span>
          <IconPicker labelledBy="list-icon-label" value={listIcon(input)}
            onChange={(icon) => setInput({ ...input, icon: icon === DEFAULT_LIST_ICON ? null : icon })} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!input.name.trim() || saving}>{existing ? 'Save' : 'Create list'}</button>
        </div>
      </form>
    </Modal>
  );
}
