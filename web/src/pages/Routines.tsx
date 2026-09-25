import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { TemplateGallery } from '../components/onboarding.tsx';
import { useToast } from '../components/toast.tsx';
import { ConfirmDialog, CopyButton, Empty, ErrorNote, Icon, JsonBlock, Menu, Section, Skeleton } from '../components/ui.tsx';
import { ActionFlow, AppearanceDialog, routineLook, RunHistory, StatusIcon, type Appearance } from '../components/visual.tsx';
import { dateTime, dayClock, describeTrigger, relative, testPayload, TRIGGER_ICONS, webhookUrl } from '../format.ts';
import { navigate, useNow, usePolling } from '../hooks.ts';
import type { Routine } from '../types.ts';
import { ExecutionRow } from './Executions.tsx';

/**
 * Starts a routine the way its trigger would: a webhook routine gets a test event through its
 * own URL – so the run has a body to work with – everything else a manual trigger.
 */
export async function startRoutine(routine: Pick<Routine, 'id' | 'webhookPath'>, payload?: Record<string, unknown>): Promise<string> {
  if (routine.webhookPath) return (await api.callWebhook(routine.webhookPath, payload ?? testPayload())).executionId;
  return (await api.trigger(routine.id)).id;
}

/** "Run now" or, for webhook routines, "Send test". */
export const runLabel = (routine: Pick<Routine, 'webhookPath'>) => (routine.webhookPath ? 'Send test' : 'Run now');

/** Shared "run now" behaviour: trigger, then jump to the live execution view. `running` drives the button spinner. */
export function useRunRoutine() {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const run = async (routine: Routine) => {
    setRunning(true);
    try {
      navigate(`/executions/${await startRoutine(routine)}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      setRunning(false);
    }
  };
  return Object.assign(run, { running });
}

/**
 * Flips the switch at once and lets the server catch up: waiting a round trip to
 * see your own click land is what makes a tool feel slow. `override` is the
 * optimistic value until the reload arrives; a failure rolls it back.
 */
function useSetActive(routine: Routine, onChange: () => void) {
  const toast = useToast();
  const [override, setOverride] = useState<boolean>();
  // the poll caught up – from here on the server's value is the truth again
  useEffect(() => {
    if (override === routine.active) setOverride(undefined);
  }, [override, routine.active]);
  const set = async (active: boolean) => {
    setOverride(active);
    try {
      await api.setActive(routine.id, active);
      onChange();
    } catch (error) {
      setOverride(undefined);
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };
  return { set, active: override ?? routine.active };
}

/** "Manual" / "Every weekday at 07:30" – when, as a label. */
const whenText = (routine: Routine) => describeTrigger(routine.trigger);

/**
 * A routine as a Shortcuts-style tile in its own colour and symbol,
 * the whole tile opens it, and the round button runs it. A paused routine turns
 * plain white and offers "Activate" instead – a disabled play button would not
 * say what to do about it.
 */
export function RoutineTile({ routine, onChanged, level = 3 }: { routine: Routine; onChanged: () => void; level?: 2 | 3 }) {
  const Heading = level === 2 ? 'h2' : 'h3';
  const run = useRunRoutine();
  const { set, active } = useSetActive(routine, onChanged);
  const look = routineLook(routine);
  return (
    <article className={`tile tint-${look.tint} ${active ? '' : 'paused'}`}>
      <a className="tile-link" href={`#/routines/${routine.id}`}>
        <span className="tile-top">
          <span className="tile-icon" aria-hidden="true"><Icon name={look.glyph} size={21} /></span>
          {!active && <span className="tile-state">Paused</span>}
        </span>
        <Heading className="tile-name">{routine.name}</Heading>
        <span className="tile-when">
          <Icon name={TRIGGER_ICONS[routine.trigger.type]} size={13} />
          <span className="ellipsis">{whenText(routine)}</span>
        </span>
      </a>
      <div className="tile-foot">
        {active ? (
          <button type="button" className="play" aria-label={`${runLabel(routine)}: ${routine.name}`} title={runLabel(routine)} disabled={run.running} onClick={() => void run(routine)}>
            {run.running ? <span className="spinner" /> : <Icon name="play" size={16} />}
          </button>
        ) : (
          <button type="button" className="btn small tinted" onClick={() => void set(true)}>
            Activate
          </button>
        )}
      </div>
    </article>
  );
}

const SCOPES = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Paused' },
] as const;

export function Routines() {
  const routines = usePolling(() => api.routines(), 5000);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<(typeof SCOPES)[number]['key']>('all');
  const [showTemplates, setShowTemplates] = useState(false);

  const all = routines.data ?? [];
  const term = search.trim().toLowerCase();
  const visible = all.filter((routine) => {
    if (scope === 'active' && !routine.active) return false;
    if (scope === 'inactive' && routine.active) return false;
    if (!term) return true;
    return `${routine.name} ${routine.description}`.toLowerCase().includes(term);
  });
  const count = (key: (typeof SCOPES)[number]['key']) =>
    key === 'all' ? all.length : all.filter((routine) => routine.active === (key === 'active')).length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Routines</h1>
        </div>
        <div className="row">
          {all.length > 0 && (
            <button type="button" className="btn" aria-expanded={showTemplates} onClick={() => setShowTemplates(!showTemplates)}>
              <Icon name="sparkles" size={16} /> Templates
            </button>
          )}
          <button type="button" className="btn primary" onClick={() => navigate('/routines/new')}>
            <Icon name="plus" size={16} /> New routine
          </button>
        </div>
      </header>
      <ErrorNote error={routines.error} onRetry={routines.reload} />

      {showTemplates && all.length > 0 && <TemplateGallery onCreated={routines.reload} />}

      {all.length > 3 && (
        <div className="filter-bar">
          <div className="segmented" role="tablist" aria-label="Filter routines">
            {SCOPES.map((item) => (
              <button key={item.key} type="button" role="tab" aria-selected={scope === item.key}
                className={scope === item.key ? 'active' : ''} onClick={() => setScope(item.key)}>
                {item.label} <span className="seg-count">{count(item.key)}</span>
              </button>
            ))}
          </div>
          <div className="search">
            <Icon name="search" size={16} />
            <input type="search" value={search} placeholder="Search" aria-label="Search routines"
              onChange={(event) => setSearch(event.target.value)} />
          </div>
        </div>
      )}

      {routines.loading ? <div className="card"><Skeleton lines={4} /></div> : all.length === 0 ? (
        // the same gallery as the welcome screen: an empty list is the moment a
        // ready-made example is worth most, not a sentence about one
        <TemplateGallery onCreated={routines.reload} />
      ) : visible.length === 0 ? (
        <div className="card">
          <Empty icon="search" title="No matching routine"
            action={<button type="button" className="btn" onClick={() => { setSearch(''); setScope('all'); }}>Reset filters</button>}>
</Empty>
        </div>
      ) : (
        <div className="tile-grid">
          {visible.map((routine) => <RoutineTile key={routine.id} routine={routine} onChanged={routines.reload} level={2} />)}
          {!term && scope !== 'inactive' && (
            <a className="tile-new" href="#/routines/new"><Icon name="plus" size={26} /> New routine</a>
          )}
        </div>
      )}
    </div>
  );
}

export function RoutineDetail({ id }: { id: string }) {
  const toast = useToast();
  const run = useRunRoutine();
  const now = useNow(5000);
  const [activating, setActivating] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [pickingLook, setPickingLook] = useState(false);
  // webhook routines: a hand-written test event, for trying the routine without an external system
  const [testBody, setTestBody] = useState<string | null>(null);
  const [testError, setTestError] = useState<string>();
  const routine = usePolling(() => api.routine(id), 5000, [id]);
  const executions = usePolling(() => api.routineExecutions(id, 40), 2000, [id]);

  if (routine.error && !routine.data) {
    return (
      <div className="page">
        <a className="back" href="#/routines"><Icon name="back" size={18} /> Routines</a>
        <ErrorNote error={routine.error} onRetry={routine.reload} />
      </div>
    );
  }
  // Keep the chrome while loading: a bare spinner would drop the way back out.
  if (!routine.data) {
    return (
      <div className="page">
        <a className="back" href="#/routines"><Icon name="back" size={18} /> Routines</a>
        <div className="card"><Skeleton lines={2} /></div>
        <div className="card"><Skeleton lines={4} /></div>
      </div>
    );
  }
  const r = routine.data;
  const runs = executions.data ?? [];
  const last = runs[0];
  const finished = runs.filter((execution) => execution.status === 'COMPLETED' || execution.status === 'FAILED');
  const ok = finished.filter((execution) => execution.status === 'COMPLETED').length;
  const look = routineLook(r);

  async function saveAppearance(next: Appearance) {
    setPickingLook(false);
    routine.mutate(() => ({ ...r, ...next }));
    try {
      await api.setAppearance(r.id, next);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      routine.reload();
    }
  }

  function openTest() {
    setTestError(undefined);
    setTestBody(JSON.stringify(testPayload(), null, 2));
  }

  async function sendTest() {
    let payload: unknown;
    try {
      payload = JSON.parse(testBody ?? '{}');
    } catch {
      setTestError('This is not valid JSON.');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      setTestError('Send a JSON object, e.g. { "name": "value" }.');
      return;
    }
    setTestBody(null);
    try {
      navigate(`/executions/${await startRoutine(r, payload as Record<string, unknown>)}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /** A copy starts paused, so it cannot fire twice alongside the original before it is edited. */
  async function duplicate() {
    setDuplicating(true);
    try {
      const copy = await api.createRoutine({
        name: `${r.name} (copy)`.slice(0, 120), description: r.description, trigger: r.trigger, actions: r.actions, icon: r.icon, color: r.color,
      });
      toast(`"${copy.name}" created`);
      navigate(`/routines/${copy.id}/settings`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      setDuplicating(false);
    }
  }

  async function activate() {
    setActivating(true);
    try {
      await api.setActive(r.id, true);
      routine.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setActivating(false);
    }
  }

  return (
    <div className="page">
      <a className="back" href="#/routines"><Icon name="back" size={18} /> Routines</a>

      {/* always in the routine's own colour – paused is said by the badge, not by losing the colour */}
      <header className={`detail-hero on-tint tint-${look.tint}`}>
        <button type="button" className="hero-icon" onClick={() => setPickingLook(true)} aria-label="Change icon and colour" title="Change icon and colour">
          <Icon name={look.glyph} size={36} />
        </button>
        <div className="grow">
          <h1>{r.name}{!r.active && <span className="hero-state">Paused</span>}</h1>
          {r.description && <p>{r.description}</p>}
        </div>
        <div className="hero-actions">
          {r.active ? (
            <button type="button" className="btn on-tint large" disabled={run.running} onClick={() => (r.webhookPath ? openTest() : void run(r))}>
              {run.running ? <span className="spinner" /> : <Icon name="play" size={16} />} {runLabel(r)}
            </button>
          ) : (
            <button type="button" className="btn on-tint large" disabled={activating} onClick={() => void activate()}>
              {activating ? <span className="spinner" /> : <Icon name="play" size={16} />} Activate
            </button>
          )}
          <Menu label="More actions" buttonClassName="btn on-tint-soft icon-only" items={[
            { label: 'Settings', icon: 'sliders', onSelect: () => navigate(`/routines/${r.id}/settings`) },
            { label: 'Duplicate', icon: 'copy', onSelect: () => void duplicate(), disabled: duplicating },
          ]} />
        </div>
      </header>

      <AppearanceDialog open={pickingLook} value={{ icon: r.icon, color: r.color }} actions={r.actions}
        onClose={() => setPickingLook(false)} onSave={(next) => void saveAppearance(next)} />

      <ConfirmDialog
        open={testBody !== null}
        title="Send a test event"
        confirmLabel="Send"
        onCancel={() => setTestBody(null)}
        onConfirm={() => void sendTest()}
      >
        <label className="field">
          <span>JSON body – steps read it as {'{{trigger.body.…}}'}</span>
          <textarea className={`mono ${testError ? 'invalid' : ''}`} rows={8} value={testBody ?? ''} spellCheck={false}
            aria-invalid={testError ? true : undefined} onChange={(event) => { setTestBody(event.target.value); setTestError(undefined); }} />
          {testError && <small className="field-error">{testError}</small>}
        </label>
      </ConfirmDialog>

      <div className="facts">
        {/* "when" is told once – here, as the first block of the flow below says it too */}
        <div className="fact">
          <span className="glyph tint-sky" aria-hidden="true"><Icon name={TRIGGER_ICONS[r.trigger.type]} size={18} /></span>
          <span className="grow">
            <span className="fact-label">{whenText(r)}</span>
            <span className="fact-value">
              {!r.active ? 'Paused' : r.nextRunAt ? relative(r.nextRunAt, now) : r.trigger.type === 'webhook' ? 'On each call' : r.trigger.type === 'manual' ? 'On demand' : '–'}
            </span>
            {r.active && r.nextRunAt && <span className="fact-sub">{dayClock(r.nextRunAt)}</span>}
            {r.webhookPath && (
              <span className="fact-sub webhook-line">
                <code className="ellipsis">{webhookUrl(r.webhookPath)}</code>
                <CopyButton value={webhookUrl(r.webhookPath)} what="webhook URL" />
              </span>
            )}
          </span>
        </div>
        <div className="fact">
          {last ? <StatusIcon status={last.status} size={32} /> : <span className="glyph tint-grey" aria-hidden="true"><Icon name="executions" size={18} /></span>}
          <span>
            <span className="fact-label">Last run</span>
            <span className="fact-value">{last ? relative(last.createdAt, now) : 'Never'}</span>
            {finished.length > 0 && <span className="fact-sub">{ok} of {finished.length} succeeded</span>}
          </span>
        </div>
      </div>

      <div className="grid-2">
        <Section id="story-title" title="Steps">
          <ActionFlow actions={r.actions} />
        </Section>
        <Section id="runs-title" title="Runs" action={runs.length > 0 ? <a className="see-all" href="#/executions">All <Icon name="chevron" size={14} /></a> : undefined}>
          {executions.loading ? <div className="card"><Skeleton lines={3} /></div> : runs.length === 0 ? (
            <div className="card">
              <Empty icon="executions" title="Never run"
                action={r.active
                  ? <button type="button" className="btn primary" disabled={run.running} onClick={() => (r.webhookPath ? openTest() : void run(r))}><Icon name="play" size={16} /> {runLabel(r)}</button>
                  : <span className="muted small">Activate it to run it.</span>} />
            </div>
          ) : (
            <>
              {runs.length >= 5 && <div className="card"><RunHistory executions={runs} now={now} /></div>}
              <ul className="list">
                {runs.slice(0, 6).map((execution) => (
                  <li key={execution.id}><ExecutionRow execution={execution} now={now} hideName /></li>
                ))}
              </ul>
            </>
          )}
        </Section>
      </div>

      <details className="under-hood">
        <summary>
          <span className="glyph tint-grey" aria-hidden="true"><Icon name="stack" size={20} /></span>
          <span className="grow">
            <strong className="block">Technical details</strong>
            <span className="muted small">{r.trigger.type === 'webhook' ? 'ID, webhook call, version, JSON' : r.trigger.type === 'schedule' ? 'ID, cron, version, JSON' : 'ID, version, JSON'}</span>
          </span>
          <Icon name="chevron" size={18} />
        </summary>
        <div className="under-hood-body">
          <dl className="kv">
            <dt>ID</dt><dd><code>{r.id}</code> <CopyButton value={r.id} what="ID" /></dd>
            <dt>Trigger</dt><dd>{r.trigger.type === 'schedule' ? <code>{r.trigger.cron} · {r.trigger.timezone}</code> : <code>{r.trigger.type}</code>}</dd>
            <dt>Version</dt><dd>{r.version} · Optimistic Locking</dd>
            <dt>Updated</dt><dd>{relative(r.updatedAt, now)}</dd>
            <dt>Created</dt><dd>{dateTime(r.createdAt)}</dd>
          </dl>
          {r.webhookPath && (
            <div>
              <h3>Call the webhook</h3>
              {/* Idempotency-Key: a sender that retries still starts only one run */}
              <div className="command">
                <code>{`curl -X POST ${webhookUrl(r.webhookPath)} -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" -d '{"hello":"world"}'`}</code>
                <CopyButton value={`curl -X POST ${webhookUrl(r.webhookPath)} -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" -d '{"hello":"world"}'`} what="command" />
              </div>
            </div>
          )}
          <JsonBlock value={{ trigger: r.trigger, actions: r.actions }} />
        </div>
      </details>
    </div>
  );
}
