import { useEffect, useRef, useState } from 'react';
import { ACTION_FORMS, GLOBAL_REFERENCES, actionIcon, actionLabel, type ParamField } from '../action-forms.ts';
import { api, ApiError } from '../api.ts';
import { StepFlow } from '../components/execution.tsx';
import { useToast } from '../components/toast.tsx';
import { Card, Disclosure, ErrorNote, Icon, JsonBlock, Loading } from '../components/ui.tsx';
import { CRON_PRESETS } from '../format.ts';
import { navigate, usePolling } from '../hooks.ts';
import { TEMPLATES } from '../templates.ts';
import type { ActionDefinition, RoutineInput } from '../types.ts';

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
  triggerType: 'manual' | 'schedule';
  cron: string;
  timezone: string;
  actions: DraftAction[];
}

const RAW_FIELD: ParamField = { name: '__raw', label: 'Parameter (JSON)', kind: 'json' };
const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
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
        throw new Error(`Aktion „${action.key}“: ${field.label} ist kein gültiges JSON`);
      }
    } else if (field.kind === 'number') {
      params[field.name] = Number(text);
    } else {
      params[field.name] = text;
    }
  }
  return params;
}

function fromRoutine(routine: RoutineInput): Draft {
  return {
    name: routine.name,
    description: routine.description ?? '',
    triggerType: routine.trigger.type,
    cron: routine.trigger.type === 'schedule' ? routine.trigger.cron : CRON_PRESETS[0].cron,
    timezone: routine.trigger.type === 'schedule' ? routine.trigger.timezone : 'Europe/Zurich',
    actions: routine.actions.map((action) => ({ uid: uid(), key: action.key, type: action.type, step: action.step, values: toValues(action.type, action.params) })),
  };
}

function toInput(draft: Draft): RoutineInput {
  const actions: ActionDefinition[] = draft.actions.map((action) => ({ key: action.key.trim(), type: action.type, step: action.step, params: toParams(action) }));
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    trigger: draft.triggerType === 'manual' ? { type: 'manual' } : { type: 'schedule', cron: draft.cron.trim(), timezone: draft.timezone.trim() || 'Europe/Zurich' },
    actions,
  };
}

function clientIssues(draft: Draft): string[] {
  const issues: string[] = [];
  if (!draft.name.trim()) issues.push('Name fehlt');
  if (draft.actions.length === 0) issues.push('Mindestens eine Aktion hinzufügen');
  const keys = new Set<string>();
  for (const action of draft.actions) {
    if (!KEY_PATTERN.test(action.key)) issues.push(`Schlüssel „${action.key}“ ungültig (Buchstabe, dann Buchstaben/Ziffern/_/-)`);
    if (keys.has(action.key)) issues.push(`Schlüssel „${action.key}“ ist doppelt`);
    keys.add(action.key);
    for (const field of fieldsFor(action.type)) {
      if (field.required && !String(action.values[field.name] ?? '').trim()) issues.push(`Aktion „${action.key}“: ${field.label} fehlt`);
    }
  }
  if (draft.triggerType === 'schedule' && !draft.cron.trim()) issues.push('Cron-Ausdruck fehlt');
  return issues;
}

const EMPTY: Draft = { name: '', description: '', triggerType: 'manual', cron: CRON_PRESETS[0].cron, timezone: 'Europe/Zurich', actions: [] };

// ---------------------------------------------------------------- component

export function RoutineEditor({ id }: { id?: string }) {
  const toast = useToast();
  const editing = Boolean(id);
  const actionTypes = usePolling(() => api.actionTypes(), 0);
  const [draft, setDraft] = useState<Draft>(() => (editing ? EMPTY : fromRoutine(TEMPLATES[0].routine)));
  const [version, setVersion] = useState<number>();
  const [loaded, setLoaded] = useState(!editing);
  const [activate, setActivate] = useState(true);
  const [issues, setIssues] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<Error>();
  const focused = useRef<{ element: HTMLInputElement | HTMLTextAreaElement; apply: (value: string) => void } | null>(null);

  async function loadExisting() {
    if (!id) return;
    try {
      const routine = await api.routine(id);
      setDraft(fromRoutine(routine));
      setVersion(routine.version);
      setConflict(false);
      setLoaded(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error : new Error(String(error)));
    }
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

  function addAction(type: string) {
    const base = type.split('.')[0];
    let key = base;
    for (let n = 2; draft.actions.some((action) => action.key === key); n++) key = `${base}${n}`;
    const step = Math.max(0, ...draft.actions.map((action) => action.step)) + 1;
    const form = ACTION_FORMS[type];
    setDraft((current) => ({ ...current, actions: [...current.actions, { uid: uid(), key, type, step, values: toValues(type, form?.defaults ?? {}) }] }));
  }

  function removeAction(actionUid: string) {
    setDraft((current) => ({ ...current, actions: current.actions.filter((action) => action.uid !== actionUid) }));
  }

  /** Inserts a {{reference}} at the cursor of the last focused text field. */
  function insertReference(reference: string) {
    const target = focused.current;
    if (!target) {
      navigator.clipboard?.writeText(reference);
      toast(`${reference} kopiert – zuerst ein Textfeld anklicken, um direkt einzufügen`);
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
      problems.push(error instanceof Error ? error.message : String(error));
      input = undefined as never;
    }
    setIssues(problems);
    if (problems.length) return;
    setSaving(true);
    try {
      if (editing && id) {
        const routine = await api.updateRoutine(id, { ...input, version });
        toast(`„${routine.name}“ gespeichert (Version ${routine.version})`);
        navigate(`/routines/${routine.id}`);
      } else {
        const routine = await api.createRoutine(input);
        if (activate) await api.setActive(routine.id, true);
        toast(`„${routine.name}“ erstellt${activate ? ' und aktiviert' : ''}`);
        navigate(`/routines/${routine.id}`);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      setIssues(error instanceof ApiError ? [error.message, ...error.details] : [String(error)]);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <div className="page"><ErrorNote error={loadError} /></div>;
  if (!loaded) return <div className="page"><Loading /></div>;

  let preview: RoutineInput | string;
  try {
    preview = toInput(draft);
  } catch (error) {
    preview = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="page">
      <a className="back" href={editing ? `#/routines/${id}` : '#/routines'}><Icon name="back" size={16} /> {editing ? 'Zurück zur Routine' : 'Routinen'}</a>
      <header className="page-head">
        <div>
          <h1>{editing ? 'Routine bearbeiten' : 'Neue Routine'}</h1>
          <p className="muted">Aktionen mit gleichem Schritt laufen parallel; spätere Schritte können Ergebnisse früherer verwenden.</p>
        </div>
        {!editing && (
          <label className="field inline">
            <span>Vorlage</span>
            <select onChange={(event) => {
              const template = TEMPLATES.find((candidate) => candidate.id === event.target.value);
              if (template) setDraft(fromRoutine(template.routine));
            }} defaultValue={TEMPLATES[0].id}>
              {TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label} – {template.hint}</option>)}
            </select>
          </label>
        )}
      </header>

      <div className="editor">
        <div className="editor-main">
          <Card title="Allgemein">
            <div className="form-grid">
              <label className="field">
                <span>Name *</span>
                <input value={draft.name} maxLength={120} onChange={(event) => update({ name: event.target.value })} />
              </label>
              <label className="field span-2">
                <span>Beschreibung</span>
                <input value={draft.description} maxLength={2000} onChange={(event) => update({ description: event.target.value })} />
              </label>
            </div>
          </Card>

          <Card title="Auslöser">
            <div className="segmented">
              <button type="button" className={draft.triggerType === 'manual' ? 'active' : ''} onClick={() => update({ triggerType: 'manual' })}>
                <Icon name="play" size={14} /> Manuell
              </button>
              <button type="button" className={draft.triggerType === 'schedule' ? 'active' : ''} onClick={() => update({ triggerType: 'schedule' })}>
                <Icon name="clock" size={14} /> Zeitplan
              </button>
            </div>
            {draft.triggerType === 'schedule' && (
              <div className="form-grid">
                <label className="field">
                  <span>Vorlage</span>
                  <select value={CRON_PRESETS.find((preset) => preset.cron === draft.cron)?.cron ?? ''} onChange={(event) => event.target.value && update({ cron: event.target.value })}>
                    <option value="">Eigener Ausdruck</option>
                    {CRON_PRESETS.map((preset) => <option key={preset.cron} value={preset.cron}>{preset.label}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Cron *</span>
                  <input className="mono" value={draft.cron} onChange={(event) => update({ cron: event.target.value })} />
                  <small className="muted">5 Felder, optional Sekunden als erstes Feld · min. alle 10 s</small>
                </label>
                <label className="field">
                  <span>Zeitzone</span>
                  <input value={draft.timezone} onChange={(event) => update({ timezone: event.target.value })} />
                </label>
              </div>
            )}
            {draft.triggerType === 'manual' && <p className="muted small">Die Routine wird nur über „Jetzt ausführen“ gestartet.</p>}
          </Card>

          <Card title={`Aktionen (${draft.actions.length})`}>
            <div className="action-list">
              {[...draft.actions].sort((a, b) => a.step - b.step).map((action) => {
                const earlier = draft.actions.filter((candidate) => candidate.step < action.step);
                return (
                  <div key={action.uid} className="action-editor">
                    <div className="action-editor-head">
                      <span className="flow-icon" aria-hidden="true">{actionIcon(action.type)}</span>
                      <div className="grow">
                        <strong>{actionLabel(action.type)}</strong>
                        <span className="muted small block mono">{action.type}</span>
                      </div>
                      <label className="field inline compact">
                        <span>Schritt</span>
                        <input type="number" min={1} max={50} value={action.step}
                          onChange={(event) => updateAction(action.uid, { step: Math.max(1, Math.min(50, Number(event.target.value) || 1)) })} />
                      </label>
                      <label className="field inline compact">
                        <span>Schlüssel</span>
                        <input className="mono" value={action.key} maxLength={40} onChange={(event) => updateAction(action.uid, { key: event.target.value })} />
                      </label>
                      <button type="button" className="btn ghost icon-only danger" title="Aktion entfernen" onClick={() => removeAction(action.uid)}>
                        <Icon name="trash" size={16} />
                      </button>
                    </div>

                    <div className="form-grid">
                      {fieldsFor(action.type).map((field) => {
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
                                    <input placeholder="Name" value={entry.key} onChange={(event) => setEntry({ key: event.target.value })} />
                                    <input placeholder="Inhalt" value={entry.value} onChange={(event) => setEntry({ value: event.target.value })}
                                      {...trackFocus((next) => setEntry({ value: next }))} />
                                    <button type="button" className="btn ghost icon-only" title="Entfernen"
                                      onClick={() => setValue(action.uid, field.name, entries.filter((_, i) => i !== index))}>×</button>
                                  </div>
                                );
                              })}
                              <button type="button" className="btn ghost small" onClick={() => setValue(action.uid, field.name, [...entries, { key: '', value: '' }])}>
                                <Icon name="plus" size={14} /> Abschnitt
                              </button>
                              {field.hint && <small className="muted">{field.hint}</small>}
                            </div>
                          );
                        }
                        const common = { value: value as string, placeholder: field.placeholder };
                        return (
                          <label key={field.name} className={`field ${field.kind === 'textarea' || field.kind === 'json' || field.name === 'url' ? 'span-2' : ''}`}>
                            <span>{field.label}{field.required ? ' *' : ''}</span>
                            {field.kind === 'select' ? (
                              <select {...common} onChange={(event) => apply(event.target.value)}>
                                <option value="">–</option>
                                {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                              </select>
                            ) : field.kind === 'textarea' || field.kind === 'json' ? (
                              <textarea {...common} rows={field.kind === 'json' ? 4 : 3} className={field.kind === 'json' ? 'mono' : ''}
                                onChange={(event) => apply(event.target.value)} {...trackFocus(apply)} />
                            ) : (
                              <input {...common} type={field.kind === 'number' ? 'number' : 'text'} onChange={(event) => apply(event.target.value)}
                                {...(field.kind === 'text' ? trackFocus(apply) : {})} />
                            )}
                            {field.hint && <small className="muted">{field.hint}</small>}
                          </label>
                        );
                      })}
                    </div>

                    <div className="references">
                      <span className="muted small">Einfügen:</span>
                      {earlier.flatMap((candidate) =>
                        (ACTION_FORMS[candidate.type]?.outputs ?? ['…']).map((output) => {
                          const reference = `{{actions.${candidate.key}.${output}}}`;
                          return <button key={reference} type="button" className="ref-chip" onMouseDown={(event) => event.preventDefault()} onClick={() => insertReference(reference)}>{candidate.key}.{output}</button>;
                        }),
                      )}
                      {GLOBAL_REFERENCES.map((reference) => (
                        <button key={reference} type="button" className="ref-chip global" onMouseDown={(event) => event.preventDefault()} onClick={() => insertReference(reference)}>
                          {reference.slice(2, -2)}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="add-action">
              <span className="muted small">Aktion hinzufügen:</span>
              {(actionTypes.data ?? []).map((type) => (
                <button key={type.type} type="button" className="btn ghost small" title={type.description} onClick={() => addAction(type.type)}>
                  <span aria-hidden="true">{actionIcon(type.type)}</span> {actionLabel(type.type)}
                </button>
              ))}
            </div>
          </Card>
        </div>

        <aside className="editor-side">
          <Card title="Vorschau">
            <StepFlow items={draft.actions.map((action) => ({ key: action.key, type: action.type, step: action.step }))} />
            <Disclosure summary="Als API-Request (JSON)">
              {typeof preview === 'string' ? <p className="error-note">{preview}</p> : <JsonBlock value={editing ? { ...preview, version } : preview} />}
            </Disclosure>
          </Card>
          <Card>
            {issues.length > 0 && (
              <div className="error-note">
                <strong>Bitte korrigieren:</strong>
                <ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
                {conflict && <button type="button" className="btn small" onClick={() => void loadExisting()}>Neu laden (verwirft eigene Änderungen)</button>}
              </div>
            )}
            {!editing && (
              <label className="check">
                <input type="checkbox" checked={activate} onChange={(event) => setActivate(event.target.checked)} /> Nach dem Erstellen aktivieren
              </label>
            )}
            <button type="button" className="btn primary block" disabled={saving} onClick={save}>
              {saving ? 'Speichern …' : editing ? 'Änderungen speichern' : 'Routine erstellen'}
            </button>
            {editing && <p className="muted small center">Version {version} – bei gleichzeitiger Änderung meldet der Server einen Konflikt (409).</p>}
          </Card>
        </aside>
      </div>
    </div>
  );
}
