import { useEffect, useMemo, useRef, useState } from 'react';
import { ACTION_FORMS, GLOBAL_REFERENCES, WEBHOOK_REFERENCES, actionLabel, type ParamField } from '../action-forms.ts';
import { api, ApiError } from '../api.ts';
import { useToast } from '../components/toast.tsx';
import { ConfirmDialog, CopyButton, Disclosure, ErrorNote, Icon, IconButton, JsonBlock, Loading } from '../components/ui.tsx';
import { ActionFlow, ActionGlyph, ActionSentence, AppearanceDialog, routineLook } from '../components/visual.tsx';
import { previewCron, runTime, usesSeconds } from '../cron.ts';
import { CRON_PRESETS, TRIGGER_ICONS, webhookUrl } from '../format.ts';
import { navigate, usePolling, useUnsavedGuard } from '../hooks.ts';
import { FREQUENCIES, parseSchedule, toCron, WEEKDAYS, withFrequency, type Frequency } from '../schedule.ts';
import { TEMPLATES } from '../templates.ts';
import type { ActionDefinition, RoutineInput, Trigger, TriggerType } from '../types.ts';

// ---------------------------------------------------------------- editor model

type FieldValue = string | Array<{ key: string; value: string }>;

interface DraftAction {
  uid: string;
  key: string;
  type: string;
  step: number;
  values: Record<string, FieldValue>;
}

interface Draft {
  name: string;
  description: string;
  icon: string | null;
  color: string | null;
  active: boolean;
  triggerType: TriggerType;
  cron: string;
  timezone: string;
  actions: DraftAction[];
}

const RAW_FIELD: ParamField = { name: '__raw', label: 'Parameters (JSON)', kind: 'json' };
const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
// limits of RoutineInput in contracts/openapi/routine-api.yaml
const MAX_ACTIONS = 20;
const MAX_STEP = 50;
const uid = () => crypto.randomUUID();

function fieldsFor(type: string): ParamField[] {
  return ACTION_FORMS[type]?.fields ?? [RAW_FIELD];
}

function toValues(type: string, params: Record<string, unknown>): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of fieldsFor(type)) {
    const raw = field.name === '__raw' ? params : params[field.name];
    if (field.kind === 'keyvalue') {
      values[field.name] = Object.entries((raw as Record<string, unknown>) ?? {}).map(([key, value]) => ({ key, value: String(value) }));
    } else if (field.kind === 'json') {
      values[field.name] = raw === undefined ? '' : JSON.stringify(raw, null, 2);
    } else {
      values[field.name] = raw === undefined || raw === null ? '' : String(raw);
    }
  }
  return values;
}

/** Converts form values back into API params; throws with a readable message on invalid JSON. */
function toParams(action: DraftAction): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const field of fieldsFor(action.type)) {
    const value = action.values[field.name];
    if (field.kind === 'keyvalue') {
      const entries = (value as Array<{ key: string; value: string }>).filter((entry) => entry.key.trim());
      if (entries.length) params[field.name] = Object.fromEntries(entries.map((entry) => [entry.key.trim(), entry.value]));
      continue;
    }
    const text = (value as string) ?? '';
    if (text.trim() === '') continue;
    if (field.kind === 'json') {
      try {
        const parsed = JSON.parse(text);
        if (field.name === '__raw') Object.assign(params, parsed);
        else params[field.name] = parsed;
      } catch {
        throw new Error(`${actionLabel(action.type)}: ${field.label} is not valid JSON`);
      }
    } else if (field.kind === 'number') {
      params[field.name] = Number(text);
    } else {
      params[field.name] = text;
    }
  }
  return params;
}

/** Templates carry no `active` – a routine made from one starts active. */
function fromRoutine(routine: RoutineInput & { active?: boolean }): Draft {
  return {
    name: routine.name,
    description: routine.description ?? '',
    icon: routine.icon ?? null,
    color: routine.color ?? null,
    active: routine.active ?? true,
    triggerType: routine.trigger.type,
    cron: routine.trigger.type === 'schedule' ? routine.trigger.cron : CRON_PRESETS[0].cron,
    timezone: routine.trigger.type === 'schedule' ? routine.trigger.timezone : 'Europe/Zurich',
    actions: routine.actions.map((action) => ({ uid: uid(), key: action.key, type: action.type, step: action.step, values: toValues(action.type, action.params) })),
  };
}

function toTrigger(draft: Draft): Trigger {
  if (draft.triggerType === 'schedule') return { type: 'schedule', cron: draft.cron.trim(), timezone: draft.timezone.trim() || 'Europe/Zurich' };
  return { type: draft.triggerType };
}

const TRIGGER_CHOICES: Array<{ type: TriggerType; label: string; icon: string }> = [
  { type: 'manual', label: 'Manual', icon: 'play' },
  { type: 'schedule', label: 'Schedule', icon: 'calendar' },
  { type: 'webhook', label: 'Webhook', icon: 'link' },
];

function toInput(draft: Draft): RoutineInput {
  const actions: ActionDefinition[] = draft.actions.map((action) => ({ key: action.key.trim(), type: action.type, step: action.step, params: toParams(action) }));
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    trigger: toTrigger(draft),
    actions,
    icon: draft.icon,
    color: draft.color,
  };
}

// ---------------------------------------------------------------- ordering
//
// The API models order as a number per action ("same step = parallel"). Asking a
// user to do that arithmetic is the least intuitive part of the editor, so the
// UI works on step *lanes* instead and the number is derived on the way out.

/** Actions bucketed into lanes, ordered by step; every lane runs after the one before it. */
function toLanes(actions: DraftAction[]): DraftAction[][] {
  const steps = [...new Set(actions.map((action) => action.step))].sort((a, b) => a - b);
  return steps.map((step) => actions.filter((action) => action.step === step));
}

/** Flattens lanes back to actions with contiguous steps 1..n. */
function fromLanes(lanes: DraftAction[][]): DraftAction[] {
  return lanes.filter((lane) => lane.length > 0).flatMap((lane, index) => lane.map((action) => ({ ...action, step: index + 1 })));
}

function laneIndexOf(lanes: DraftAction[][], actionUid: string): number {
  return lanes.findIndex((lane) => lane.some((action) => action.uid === actionUid));
}

/**
 * Moves an action one position earlier or later in the sequence.
 * Alone in its lane it swaps lanes; sharing one it leaves the group first.
 */
function moveAction(actions: DraftAction[], actionUid: string, direction: -1 | 1): DraftAction[] {
  const lanes = toLanes(actions);
  const from = laneIndexOf(lanes, actionUid);
  const action = from < 0 ? undefined : lanes[from].find((candidate) => candidate.uid === actionUid);
  if (!action) return actions;
  if (lanes[from].length > 1) {
    // leaving a parallel group: become an own lane just before / after it
    const rest = lanes.map((lane, index) => (index === from ? lane.filter((candidate) => candidate.uid !== actionUid) : lane));
    rest.splice(direction === -1 ? from : from + 1, 0, [action]);
    return fromLanes(rest);
  }
  const to = from + direction;
  if (to < 0 || to >= lanes.length) return actions;
  const swapped = [...lanes];
  [swapped[from], swapped[to]] = [swapped[to], swapped[from]];
  return fromLanes(swapped);
}

/** true → run together with the lane before it; false → own lane right after it. */
function setParallel(actions: DraftAction[], actionUid: string, parallel: boolean): DraftAction[] {
  const lanes = toLanes(actions);
  const from = laneIndexOf(lanes, actionUid);
  const action = from < 0 ? undefined : lanes[from].find((candidate) => candidate.uid === actionUid);
  if (!action) return actions;
  const without = lanes.map((lane, index) => (index === from ? lane.filter((candidate) => candidate.uid !== actionUid) : lane));
  if (parallel) {
    if (from === 0) return actions;
    without[from - 1] = [...without[from - 1], action];
    return fromLanes(without);
  }
  without.splice(from + 1, 0, [action]);
  return fromLanes(without);
}

// ---------------------------------------------------------------- validation

export interface Issue {
  message: string;
  /** DOM id of the field to focus when the user clicks the issue. */
  target?: string;
}

const nameFieldId = 'field-name';
const fieldId = (actionUid: string, field: string) => `field-${actionUid}-${field}`;

function clientIssues(draft: Draft): Issue[] {
  const issues: Issue[] = [];
  if (!draft.name.trim()) issues.push({ message: 'Give the routine a name', target: nameFieldId });
  if (draft.actions.length === 0) issues.push({ message: 'Add at least one step' });
  const keys = new Set<string>();
  for (const action of draft.actions) {
    const keyTarget = fieldId(action.uid, 'key');
    if (!KEY_PATTERN.test(action.key)) issues.push({ message: `${actionLabel(action.type)}: ID "${action.key}" is invalid – letters, digits, _ and - only, starting with a letter`, target: keyTarget });
    if (keys.has(action.key)) issues.push({ message: `ID "${action.key}" is used twice`, target: keyTarget });
    keys.add(action.key);
    for (const field of fieldsFor(action.type)) {
      if (field.required && !String(action.values[field.name] ?? '').trim()) {
        issues.push({ message: `${actionLabel(action.type)}: ${field.label} is missing`, target: fieldId(action.uid, field.name) });
      }
    }
  }
  if (draft.triggerType === 'schedule') {
    // the same check the preview shows, so nothing can fail on save that looked fine
    const preview = previewCron(draft.cron, draft.timezone || 'Europe/Zurich');
    if (!preview.ok) issues.push({ message: preview.message, target: preview.message.includes('time zone') ? 'field-timezone' : 'field-cron' });
  }
  return issues;
}

/** Moves the user to the first thing they need to fix rather than just listing it. */
function focusField(target: string | undefined) {
  if (!target) return;
  const element = document.getElementById(target);
  if (!element) return;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  element.focus({ preventScroll: true });
}

/** Every zone the browser knows, so the field completes instead of guessing. */
const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Zurich', 'Europe/Berlin', 'Europe/London', 'UTC'];
  }
})();

const EMPTY: Draft = { name: '', description: '', icon: null, color: null, active: true, triggerType: 'manual', cron: CRON_PRESETS[0].cron, timezone: 'Europe/Zurich', actions: [] };

// ---------------------------------------------------------------- component

/** Params for the sentence preview – an invalid JSON field must not break the header. */
function safeParams(action: DraftAction): Record<string, unknown> {
  try {
    return toParams(action);
  } catch {
    return {};
  }
}

export function RoutineEditor({ id }: { id?: string }) {
  const toast = useToast();
  const editing = Boolean(id);
  const actionTypes = usePolling(() => api.actionTypes(), 0);
  const taskLists = usePolling(() => api.taskLists(), 0);
  // One shared starting value: fromRoutine() mints random uids, so calling it
  // twice would make the draft differ from its own baseline and read as dirty.
  const [initial] = useState<Draft>(EMPTY);
  const [draft, setDraft] = useState<Draft>(initial);
  const [version, setVersion] = useState<number>();
  const [loaded, setLoaded] = useState(!editing);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<Error>();
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const [pickingLook, setPickingLook] = useState(false);
  // Which action cards are unfolded. A saved routine opens as an overview; a new
  // action opens so it can be filled in.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [customCron, setCustomCron] = useState(false);
  // the URL exists once the server has stored a webhook routine
  const [webhookPath, setWebhookPath] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const focused = useRef<{ element: HTMLInputElement | HTMLTextAreaElement; apply: (value: string) => void } | null>(null);

  // Compared as serialised drafts: cheap, and it resets itself after a save.
  const dirty = loaded && JSON.stringify(draft) !== baseline;
  useUnsavedGuard(dirty);

  const lanes = useMemo(() => toLanes(draft.actions), [draft.actions]);
  const types = useMemo(() => Object.fromEntries(draft.actions.map((action) => [action.key, action.type])), [draft.actions]);
  // Cron is unreadable; showing what it means and when it fires turns typing into checking.
  const schedule = useMemo(
    () => (draft.triggerType === 'schedule' ? previewCron(draft.cron, draft.timezone || 'Europe/Zurich') : undefined),
    [draft.triggerType, draft.cron, draft.timezone],
  );
  const simple = parseSchedule(draft.cron);
  const frequency: Frequency = customCron || !simple ? 'custom' : simple.frequency;
  // Which fields to flag inline – rebuilt from the issues raised by the last save attempt.
  // the look only needs each step's type – params may be half-typed JSON at this point
  const lookActions = useMemo(() => draft.actions.map((action) => ({ key: action.key, type: action.type, step: action.step, params: {} })), [draft.actions]);
  const look = routineLook({ actions: lookActions, icon: draft.icon, color: draft.color });
  const invalid = useMemo(() => new Map(issues.filter((issue) => issue.target).map((issue) => [issue.target, issue.message])), [issues]);

  async function loadExisting() {
    if (!id) return;
    try {
      const routine = await api.routine(id);
      const next = fromRoutine(routine);
      setDraft(next);
      setBaseline(JSON.stringify(next));
      setVersion(routine.version);
      setWebhookPath(routine.webhookPath);
      setConflict(false);
      setCustomCron(routine.trigger.type === 'schedule' && !parseSchedule(routine.trigger.cron));
      setLoaded(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function applyTemplate(templateId: string) {
    const template = TEMPLATES.find((candidate) => candidate.id === templateId);
    if (!template) return;
    const next = fromRoutine(template.routine);
    setDraft(next);
    setBaseline(JSON.stringify(EMPTY));
    setExpanded(new Set());
    setCustomCron(template.routine.trigger.type === 'schedule' && !parseSchedule(template.routine.trigger.cron));
    setIssues([]);
  }

  useEffect(() => {
    void loadExisting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const updateAction = (key: string, patch: Partial<DraftAction>) =>
    setDraft((current) => ({ ...current, actions: current.actions.map((action) => (action.uid === key ? { ...action, ...patch } : action)) }));
  const setValue = (actionUid: string, field: string, value: FieldValue) =>
    setDraft((current) => ({
      ...current,
      actions: current.actions.map((action) => (action.uid === actionUid ? { ...action, values: { ...action.values, [field]: value } } : action)),
    }));
  const toggleExpanded = (actionUid: string, open?: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open ?? !next.has(actionUid)) next.add(actionUid);
      else next.delete(actionUid);
      return next;
    });

  function addAction(type: string) {
    const base = type.split('.')[0];
    let key = base;
    for (let n = 2; draft.actions.some((action) => action.key === key); n++) key = `${base}${n}`;
    // the API allows steps 1–50; beyond that a new action joins the last step (runs in parallel)
    const step = Math.min(MAX_STEP, Math.max(0, ...draft.actions.map((action) => action.step)) + 1);
    const form = ACTION_FORMS[type];
    const action = { uid: uid(), key, type, step, values: toValues(type, form?.defaults ?? {}) };
    setDraft((current) => ({ ...current, actions: [...current.actions, action] }));
    toggleExpanded(action.uid, true);
    // a freshly added card is below the fold on a long routine
    requestAnimationFrame(() => focusField(fieldId(action.uid, fieldsFor(type)[0]?.name ?? 'key')));
  }

  function removeAction(actionUid: string) {
    setDraft((current) => ({ ...current, actions: fromLanes(toLanes(current.actions.filter((action) => action.uid !== actionUid))) }));
  }

  const reorder = (actionUid: string, direction: -1 | 1) =>
    setDraft((current) => ({ ...current, actions: moveAction(current.actions, actionUid, direction) }));

  const toggleParallel = (actionUid: string, parallel: boolean) =>
    setDraft((current) => ({ ...current, actions: setParallel(current.actions, actionUid, parallel) }));

  /** Inserts a {{reference}} at the cursor of the last focused text field. */
  function insertReference(reference: string) {
    const target = focused.current;
    if (!target) {
      navigator.clipboard?.writeText(reference);
      toast('Copied – click into a text field first to insert it there');
      return;
    }
    const { element, apply } = target;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    const next = element.value.slice(0, start) + reference + element.value.slice(end);
    apply(next);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + reference.length, start + reference.length);
    });
  }

  async function rotateWebhook() {
    if (!id) return;
    setConfirmRotate(false);
    setRotating(true);
    try {
      const routine = await api.rotateWebhook(id);
      setWebhookPath(routine.webhookPath);
      setVersion(routine.version);
      toast('New webhook URL created – the old one no longer works');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setRotating(false);
    }
  }

  const trackFocus = (apply: (value: string) => void) => ({
    onFocus: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      focused.current = { element: event.currentTarget, apply };
    },
  });

  async function save() {
    const problems = clientIssues(draft);
    let input: RoutineInput;
    try {
      input = toInput(draft);
    } catch (error) {
      problems.push({ message: error instanceof Error ? error.message : String(error) });
      input = undefined as never;
    }
    setIssues(problems);
    if (problems.length) {
      // a problem inside a folded card has to be unfolded before it can be shown
      const broken = draft.actions.filter((action) => problems.some((issue) => issue.target?.startsWith(`field-${action.uid}-`)));
      setExpanded((current) => new Set([...current, ...broken.map((action) => action.uid)]));
      const target = problems.find((issue) => issue.target)?.target;
      if (target?.includes('cron') || target?.includes('timezone')) setCustomCron(true);
      requestAnimationFrame(() => focusField(target));
      return;
    }
    setSaving(true);
    try {
      if (editing && id) {
        let routine = await api.updateRoutine(id, { ...input, version });
        if (routine.active !== draft.active) routine = await api.setActive(id, draft.active);
        setBaseline(JSON.stringify(draft));
        toast(`"${routine.name}" saved`);
        navigate(`/routines/${routine.id}`);
      } else {
        const routine = await api.createRoutine(input);
        if (draft.active) await api.setActive(routine.id, true);
        setBaseline(JSON.stringify(draft));
        toast(`"${routine.name}" created`);
        navigate(`/routines/${routine.id}`);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      setIssues(
        error instanceof ApiError
          ? [{ message: error.message }, ...error.details.map((detail) => ({ message: detail }))]
          : [{ message: String(error) }],
      );
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!id) return;
    setConfirmDelete(false);
    try {
      await api.deleteRoutine(id);
      toast(`"${draft.name}" deleted`);
      navigate('/routines');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  // a failed load used to be a dead end: no retry, no way back except the browser
  if (loadError) return (
    <div className="page">
      <a className="back" href="#/routines"><Icon name="back" size={18} /> Routines</a>
      <ErrorNote error={loadError} onRetry={() => { setLoadError(undefined); void loadExisting(); }} />
    </div>
  );
  if (!loaded) return <div className="page"><Loading /></div>;

  let preview: RoutineInput | string;
  try {
    preview = toInput(draft);
  } catch (error) {
    preview = error instanceof Error ? error.message : String(error);
  }

  const leaveHref = editing ? `#/routines/${id}` : '#/routines';
  const timezone = draft.timezone || 'Europe/Zurich';
  const blank = !editing && draft.actions.length === 0 && !draft.name;
  const catalog = actionTypes.data ?? Object.keys(ACTION_FORMS).map((type) => ({ type, description: '', requiredParams: [], example: {} }));

  const renderField = (action: DraftAction, field: ParamField) => {
    const value = action.values[field.name];
    const apply = (next: string) => setValue(action.uid, field.name, next);
    if (field.kind === 'keyvalue') {
      const entries = value as Array<{ key: string; value: string }>;
      return (
        <div key={field.name} className="field span-2">
          <span>{field.label}</span>
          {entries.map((entry, index) => {
            const setEntry = (patch: Partial<{ key: string; value: string }>) =>
              setValue(action.uid, field.name, entries.map((candidate, i) => (i === index ? { ...candidate, ...patch } : candidate)));
            return (
              <div key={index} className="kv-row">
                <input placeholder="Heading" aria-label="Heading" value={entry.key} onChange={(event) => setEntry({ key: event.target.value })} />
                <input placeholder="Content" aria-label="Content" value={entry.value} onChange={(event) => setEntry({ value: event.target.value })}
                  {...trackFocus((next) => setEntry({ value: next }))} />
                <IconButton icon="x" label={`Remove section ${entry.key || index + 1}`}
                  onClick={() => setValue(action.uid, field.name, entries.filter((_, i) => i !== index))} />
              </div>
            );
          })}
          <button type="button" className="btn ghost small" style={{ alignSelf: 'flex-start' }}
            onClick={() => setValue(action.uid, field.name, [...entries, { key: '', value: '' }])}>
            <Icon name="plus" size={14} /> Add section
          </button>
          {field.hint && <small className="muted">{field.hint}</small>}
        </div>
      );
    }
    const fid = fieldId(action.uid, field.name);
    const problem = invalid.get(fid);
    const common = { id: fid, value: value as string, placeholder: field.placeholder, 'aria-invalid': problem ? true : undefined };
    return (
      <label key={field.name} className={`field ${field.kind === 'textarea' || field.kind === 'json' || field.name === 'url' ? 'span-2' : ''}`}>
        <span>{field.label}</span>
        {field.kind === 'tasklist' ? (
          <select {...common} className={problem ? 'invalid' : ''} onChange={(event) => apply(event.target.value)}>
            <option value="">{taskLists.data?.find((list) => list.isDefault)?.name ?? 'Todo'} (default)</option>
            {taskLists.data?.filter((list) => !list.isDefault).map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
            {/* a list deleted since: say so instead of silently showing "default" */}
            {value && taskLists.data && !taskLists.data.some((list) => list.id === value) && <option value={value as string}>Deleted list – uses default</option>}
          </select>
        ) : field.kind === 'select' ? (
          <select {...common} className={problem ? 'invalid' : ''} onChange={(event) => apply(event.target.value)}>
            <option value="">Default</option>
            {field.options?.map((option) => <option key={option} value={option}>{field.optionLabels?.[option] ?? option}</option>)}
          </select>
        ) : field.kind === 'textarea' || field.kind === 'json' ? (
          <textarea {...common} rows={field.kind === 'json' ? 4 : 3} className={`${field.kind === 'json' ? 'mono' : ''} ${problem ? 'invalid' : ''}`}
            onChange={(event) => apply(event.target.value)} {...trackFocus(apply)} />
        ) : (
          <input {...common} className={problem ? 'invalid' : ''} type={field.kind === 'number' ? 'number' : 'text'} min={field.kind === 'number' ? 0 : undefined}
            onChange={(event) => apply(event.target.value)} {...(field.kind === 'text' ? trackFocus(apply) : {})} />
        )}
        {problem && <small className="field-error">{problem}</small>}
        {field.hint && <small className="muted">{field.hint}</small>}
      </label>
    );
  };

  return (
    <div className="page">
      <a className="back" href={leaveHref} onClick={(event) => {
        if (dirty && !confirm('Discard changes?')) event.preventDefault();
      }}><Icon name="back" size={18} /> {editing ? 'Back' : 'Routines'}</a>

      <ConfirmDialog open={confirmDelete} title={`Delete "${draft.name || 'this routine'}"?`} confirmLabel="Delete" danger
        onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()}>
        <p>The routine and its history will be removed permanently. To stop it for a while, switch it off instead.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingTemplate !== null}
        title="Use this template?"
        confirmLabel="Use template"
        danger
        onCancel={() => setPendingTemplate(null)}
        onConfirm={() => {
          if (pendingTemplate) applyTemplate(pendingTemplate);
          setPendingTemplate(null);
        }}
      >
        <p>Your current input will be replaced.</p>
      </ConfirmDialog>

      <div className="editor">
        <div className="editor-main">
          <header className="editor-head">
            <button type="button" className={`glyph editor-look tint-${look.tint}`} onClick={() => setPickingLook(true)}
              aria-label="Change icon and colour" title="Change icon and colour">
              <Icon name={look.glyph} size={30} />
            </button>
            <div className="grow">
            <h1 className="eyebrow">{editing ? 'Settings' : 'New routine'}</h1>
            <input id={nameFieldId} className={`title-input ${invalid.has(nameFieldId) ? 'invalid' : ''}`} value={draft.name} maxLength={120}
              placeholder="Name" aria-label="Name" aria-invalid={invalid.has(nameFieldId) || undefined}
              onChange={(event) => update({ name: event.target.value })} />
            {invalid.has(nameFieldId) && <small className="field-error">{invalid.get(nameFieldId)}</small>}
            <input className="desc-input" value={draft.description} maxLength={2000} placeholder="Description (optional)"
              aria-label="Description" onChange={(event) => update({ description: event.target.value })} />
            </div>
          </header>

          <AppearanceDialog open={pickingLook} value={{ icon: draft.icon, color: draft.color }} actions={lookActions}
            onClose={() => setPickingLook(false)} onSave={(next) => { update(next); setPickingLook(false); }} />

          {issues.length > 0 && (
            <div className="error-note" role="alert">
              <Icon name="warning" size={18} />
              <div className="grow">
                <strong>{issues.length === 1 ? '1 thing left to fix' : `${issues.length} things left to fix`}</strong>
                <ul>
                  {issues.map((issue) => (
                    <li key={issue.message}>
                      {issue.target
                        ? <button type="button" className="link" onClick={() => focusField(issue.target)}>{issue.message}</button>
                        : issue.message}
                    </li>
                  ))}
                </ul>
                {conflict && <button type="button" className="btn small" onClick={() => void loadExisting()}>Reload</button>}
              </div>
            </div>
          )}

          {blank && (
            <section className="section" aria-labelledby="start-with">
              <h2 id="start-with" className="group-label" style={{ margin: 0 }}>Start from a template</h2>
              <div className="template-strip">
                {TEMPLATES.map((template) => (
                  <button key={template.id} type="button" className="template-pick" title={template.hint}
                    onClick={() => (dirty ? setPendingTemplate(template.id) : applyTemplate(template.id))}>
                    <ActionGlyph type={template.routine.actions[0].type} size={22} />
                    {template.label}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="q-card" aria-labelledby="q-when">
            <div className="q-head">
              <span className="glyph tint-sky" aria-hidden="true"><Icon name="clock" size={19} /></span>
              <h2 id="q-when">When?</h2>
            </div>
            {/* labels, not explanations: the preview below says what each choice means */}
            <div className="segmented large" role="radiogroup" aria-label="Start">
              {TRIGGER_CHOICES.map((choice) => (
                <button key={choice.type} type="button" role="radio" aria-checked={draft.triggerType === choice.type}
                  className={draft.triggerType === choice.type ? 'active' : ''} onClick={() => update({ triggerType: choice.type })}>
                  <Icon name={choice.icon} size={15} /> {choice.label}
                </button>
              ))}
            </div>

            {draft.triggerType === 'webhook' && (
              <div className="schedule-summary webhook-summary" aria-live="polite">
                <Icon name="link" size={20} />
                <div className="grow">
                  {webhookPath ? (
                    <>
                      <strong>POST to this URL to start the routine</strong>
                      <div className="command">
                        <code>{webhookUrl(webhookPath)}</code>
                        <CopyButton value={webhookUrl(webhookPath)} what="webhook URL" />
                      </div>
                      <button type="button" className="link small" disabled={rotating} onClick={() => setConfirmRotate(true)}>
                        {rotating ? 'Creating new URL …' : 'Create new URL'}
                      </button>
                    </>
                  ) : (
                    <strong>The URL is created when you save.</strong>
                  )}
                  <span className="hint">JSON fields are available as <code>{'{{trigger.body.name}}'}</code></span>
                </div>
              </div>
            )}

            <ConfirmDialog
              open={confirmRotate}
              title="Create a new webhook URL?"
              confirmLabel="Create new URL"
              danger
              onCancel={() => setConfirmRotate(false)}
              onConfirm={() => void rotateWebhook()}
            >
              <p>The current URL stops working immediately. Update every system that calls it.</p>
            </ConfirmDialog>

            {draft.triggerType === 'schedule' && (
              <>
                <div className="pill-group" role="radiogroup" aria-label="How often">
                  {FREQUENCIES.map((option) => (
                    <button key={option.key} type="button" role="radio" aria-checked={frequency === option.key} className="pill-option"
                      onClick={() => { setCustomCron(false); update({ cron: withFrequency(draft.cron, option.key as Exclude<Frequency, 'custom'>) }); }}>
                      {option.label}
                    </button>
                  ))}
                  {frequency === 'custom' && <span className="pill-option" role="radio" aria-checked="true">Cron</span>}
                </div>

                {simple && frequency !== 'custom' && (
                  <div className="inline-fields">
                    {frequency === 'weekly' && (
                      <div className="field">
                        <span>Days</span>
                        <div className="weekday-picker">
                          {WEEKDAYS.map((weekday) => {
                            const on = simple.days.includes(weekday.day);
                            return (
                              <button key={weekday.day} type="button" aria-pressed={on} aria-label={weekday.long} title={weekday.long}
                                onClick={() => {
                                  const days = on ? simple.days.filter((day) => day !== weekday.day) : [...simple.days, weekday.day];
                                  // at least one day – an empty week is not a schedule
                                  if (days.length) update({ cron: toCron({ ...simple, days }) });
                                }}>
                                {weekday.short}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {(frequency === 'daily' || frequency === 'weekdays' || frequency === 'weekly') && (
                      <label className="field">
                        <span>Time</span>
                        <input type="time" value={simple.time} required
                          onChange={(event) => event.target.value && update({ cron: toCron({ ...simple, time: event.target.value }) })} />
                      </label>
                    )}
                    {frequency === 'interval' && (
                      <>
                        <label className="field">
                          <span>Every</span>
                          <input type="number" min={1} max={59} value={simple.every}
                            onChange={(event) => {
                              const every = Math.max(1, Math.min(59, Number(event.target.value) || 1));
                              update({ cron: toCron({ ...simple, every }) });
                            }} />
                        </label>
                        <label className="field">
                          <span aria-hidden="true">&nbsp;</span>
                          <select aria-label="Unit" value={simple.unit} onChange={(event) => update({ cron: toCron({ ...simple, unit: event.target.value as 'minutes' | 'seconds' }) })}>
                            <option value="minutes">minutes</option>
                            <option value="seconds">seconds</option>
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                )}

                {/* The preview is the actual answer to "did I get it right?" – it
                    updates as you type and is polite so it does not interrupt typing. */}
                {schedule && (
                  <div id="cron-preview" className={`schedule-summary ${schedule.ok ? '' : 'bad'}`} aria-live="polite">
                    <Icon name={schedule.ok ? 'calendar' : 'warning'} size={20} />
                    <div className="grow">
                      {schedule.ok ? (
                        <>
                          <strong>{schedule.text ?? 'Custom schedule'}</strong>
                          <ol className="cron-runs" aria-label="Next runs">
                            {schedule.next.map((run, index) => (
                              <li key={run.toISOString()}>
                                {index === 0 && <span className="sr-only">Next run: </span>}
                                {runTime(run, timezone, usesSeconds(schedule.next))}
                              </li>
                            ))}
                          </ol>
                        </>
                      ) : <strong>{schedule.message}</strong>}
                    </div>
                  </div>
                )}

                <details className="advanced" open={frequency === 'custom' || undefined}>
                  <summary>Cron & time zone</summary>
                  <div className="form-grid">
                    <label className="field">
                      <span>Cron</span>
                      <input id="field-cron" className={`mono ${schedule?.ok === false ? 'invalid' : ''}`} value={draft.cron}
                        aria-invalid={schedule?.ok === false || undefined} aria-describedby="cron-preview cron-hint"
                        onChange={(event) => { setCustomCron(!parseSchedule(event.target.value)); update({ cron: event.target.value }); }} />
                      <small id="cron-hint" className="muted">[Sek] Min Std Tag Monat Wochentag</small>
                    </label>
                    <label className="field">
                      <span>Time zone</span>
                      <input id="field-timezone" list="timezones" className={invalid.has('field-timezone') ? 'invalid' : ''}
                        value={draft.timezone} onChange={(event) => update({ timezone: event.target.value })} />
                      <datalist id="timezones">
                        {TIMEZONES.map((zone) => <option key={zone} value={zone} />)}
                      </datalist>
                    </label>
                  </div>
                </details>
              </>
            )}
          </section>

          <section className="q-card" aria-labelledby="q-what">
            <div className="q-head">
              <span className="glyph tint-orange" aria-hidden="true"><Icon name="bolt" size={19} /></span>
              <h2 id="q-what">What?</h2>
            </div>

            {draft.actions.length > 0 && (
              <div className="action-list">
                {lanes.map((lane, laneIndex) => (
                  <section key={lane[0].uid} className={`lane ${lane.length > 1 ? 'parallel' : ''}`} aria-label={`Step ${laneIndex + 1}`}>
                    {lane.length > 1 && <span className="lane-label"><Icon name="stack" size={13} /> In parallel</span>}
                    {lane.map((action) => {
                      const earlier = draft.actions.filter((candidate) => candidate.step < action.step);
                      const shared = lane.length > 1;
                      const first = laneIndex === 0 && !shared;
                      const last = laneIndex === lanes.length - 1 && !shared;
                      const hasError = [...invalid.keys()].some((key) => key?.startsWith(`field-${action.uid}-`));
                      const open = expanded.has(action.uid);
                      const label = actionLabel(action.type);
                      const bodyId = `action-body-${action.uid}`;
                      return (
                        <div key={action.uid} className={`action-card ${hasError ? 'has-error' : ''}`} data-open={open}>
                          <div className="action-card-head">
                            <ActionGlyph type={action.type} size={36} />
                            <button type="button" className="grow link" style={{ color: 'inherit' }} aria-expanded={open} aria-controls={bodyId}
                              onClick={() => toggleExpanded(action.uid)}>
                              <span className="story-title"><ActionSentence type={action.type} params={safeParams(action)} types={types} /></span>
                            </button>
                            <div className="action-card-tools" role="group" aria-label={`${label}: order and remove`}>
                              <IconButton icon="up" label={`Move ${label} up`} disabled={first} onClick={() => reorder(action.uid, -1)} />
                              <IconButton icon="down" label={`Move ${label} down`} disabled={last} onClick={() => reorder(action.uid, 1)} />
                              <IconButton icon="trash" label={`Remove ${label}`} className="danger" onClick={() => removeAction(action.uid)} />
                              <button type="button" className="btn plain icon-only collapse" aria-label={open ? `Collapse ${label}` : `Edit ${label}`}
                                aria-expanded={open} aria-controls={bodyId} onClick={() => toggleExpanded(action.uid)}>
                                <Icon name="chevron" size={16} />
                              </button>
                            </div>
                          </div>

                          {open && (
                            <div className="action-card-body" id={bodyId}>
                              <div className="form-grid">{fieldsFor(action.type).map((field) => renderField(action, field))}</div>

                              <div className="references" role="group" aria-label="Insert value">
                                <span className="references-label">Insert</span>
                                {earlier.flatMap((candidate) =>
                                    Object.entries(ACTION_FORMS[candidate.type]?.outputs ?? {}).map(([output, name]) => {
                                      const reference = `{{actions.${candidate.key}.${output}}}`;
                                      return (
                                        <button key={reference} type="button" className="ref-chip" title={reference}
                                          onMouseDown={(event) => event.preventDefault()} onClick={() => insertReference(reference)}>
                                          <ActionGlyph type={candidate.type} size={16} /> {name}
                                        </button>
                                      );
                                    }),
                                )}
                                {Object.entries({ ...(draft.triggerType === 'webhook' ? WEBHOOK_REFERENCES : {}), ...GLOBAL_REFERENCES }).map(([reference, name]) => (
                                  <button key={reference} type="button" className="ref-chip" title={reference}
                                    onMouseDown={(event) => event.preventDefault()} onClick={() => insertReference(reference)}>
                                    {name}
                                  </button>
                                ))}
                              </div>

                              {/* Shown whenever there is something to be parallel *with*, so the
                                  control survives its own toggle: merging into step 1 would
                                  otherwise drop the lane index to 0 and unmount the switch. */}
                              {(shared || laneIndex > 0) && (
                                <label className="switch parallel-toggle">
                                  <input type="checkbox" checked={shared} onChange={(event) => toggleParallel(action.uid, event.target.checked)} />
                                  <span className="switch-track" />
                                  <span>Run in parallel with the previous step</span>
                                </label>
                              )}

                              <label className="key-field">
                                <span>ID</span>
                                <input id={fieldId(action.uid, 'key')} className={invalid.has(fieldId(action.uid, 'key')) ? 'invalid' : ''}
                                  value={action.key} maxLength={40} aria-invalid={invalid.has(fieldId(action.uid, 'key')) || undefined}
                                  onChange={(event) => updateAction(action.uid, { key: event.target.value })} />
                              </label>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </section>
                ))}
              </div>
            )}

            <div>
              <h3 style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 8 }}>
                {draft.actions.length >= MAX_ACTIONS ? `At most ${MAX_ACTIONS} steps` : 'Add a step'}
              </h3>
              <div className="palette">
                {catalog.map((type) => (
                  <button key={type.type} type="button" className="palette-item" onClick={() => addAction(type.type)}
                    title={ACTION_FORMS[type.type]?.blurb ?? type.description} disabled={draft.actions.length >= MAX_ACTIONS}>
                    <ActionGlyph type={type.type} size={30} />
                    <span className="grow">{actionLabel(type.type)}</span>
                    <Icon name="plus" size={15} />
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>

        {/* a div, not <aside>: the app shell already owns the one complementary
            landmark, and two unnamed ones are indistinguishable to a screen reader */}
        <div className="editor-side">
          <div className="card">
            <div className="card-head"><h2>Preview</h2></div>
            {draft.actions.length === 0 ? <p className="muted small">No steps yet</p> : (
              <ActionFlow compact actions={draft.actions.map((action) => ({ key: action.key, type: action.type, step: action.step, params: safeParams(action) }))}
                trigger={{
                  icon: TRIGGER_ICONS[draft.triggerType],
                  title: draft.triggerType === 'schedule' ? (schedule?.ok && schedule.text) || 'Schedule' : draft.triggerType === 'webhook' ? 'Webhook call' : 'Manual',
                }} />
            )}
            <div style={{ marginTop: 14 }}>
              <Disclosure summary="JSON">
                {typeof preview === 'string' ? <p className="error-note">{preview}</p> : <JsonBlock value={editing ? { ...preview, version } : preview} />}
              </Disclosure>
            </div>
          </div>
          <div className="card save-card">
            <label className="switch">
              <input type="checkbox" checked={draft.active} onChange={(event) => update({ active: event.target.checked })} />
              <span className="switch-track" />
              <span className="switch-label">Active</span>
            </label>
            <button type="button" className="btn primary large block" disabled={saving} onClick={save}>
              {saving ? <><span className="spinner" /> Saving</> : editing ? 'Save' : 'Create'}
            </button>
            {dirty && !issues.length && <span className="unsaved">Unsaved changes</span>}
            {issues.length > 0 && (
              <p className="field-error small center" role="status">
                {issues.length === 1 ? '1 thing to fix' : `${issues.length} things to fix`}
              </p>
            )}
          </div>
          {editing && (
            <div className="card danger-card">
              <button type="button" className="btn danger block" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" size={16} /> Delete routine
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
