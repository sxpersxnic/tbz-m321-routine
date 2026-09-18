import { useState } from 'react';
import { actionLabel } from '../action-forms.ts';
import { api } from '../api.ts';
import { Pipeline, Timeline } from '../components/execution.tsx';
import { RunOutcome } from '../components/onboarding.tsx';
import { useToast } from '../components/toast.tsx';
import { CopyButton, Empty, ErrorNote, Icon, JsonBlock, Section, Skeleton, StatusBadge } from '../components/ui.tsx';
import { startRoutine } from './Routines.tsx';
import { ActionFlow, Monogram, RoutineGlyph, StatusIcon, statusTone } from '../components/visual.tsx';
import { between, clock, dateTime, groupByDay, JAEGER_URL, relative, splitInstance, TRIGGER_WORDS } from '../format.ts';
import { navigate, useNow, usePolling, useRouteParam } from '../hooks.ts';
import { TERMINAL_STATUSES, type Execution, type ExecutionDetail as Detail, type ExecutionStatus, type Routine } from '../types.ts';

/** One run as a list row. `routine`, when known, gives the row its routine's colour and symbol. */
export function ExecutionRow({ execution, now, hideName, routine, showClock }: {
  execution: Execution;
  now: number;
  hideName?: boolean;
  routine?: Routine;
  /** In a day-grouped list the day is already said – the clock time is what differs. */
  showClock?: boolean;
}) {
  const running = !TERMINAL_STATUSES.has(execution.status);
  const took = running ? between(execution.startedAt ?? execution.createdAt, null, now) : between(execution.startedAt, execution.finishedAt);
  const how = TRIGGER_WORDS[execution.trigger];
  const when = showClock ? clock(execution.createdAt) : relative(execution.createdAt, now);
  // success is the normal case: a tick is enough, words are kept for what needs attention
  const quiet = execution.status === 'COMPLETED';
  return (
    <a href={`#/executions/${execution.id}`} className="list-row">
      {hideName
        ? <StatusIcon status={execution.status} size={26} />
        : routine ? <RoutineGlyph routine={routine} size={34} /> : <Monogram name={execution.routineName} size={34} />}
      <span className="grow">
        <span className="row-title">{hideName ? when : execution.routineName}</span>
        <span className="row-sub">{hideName ? how : `${when} · ${how}`}</span>
      </span>
      {!hideName && <StatusIcon status={execution.status} size={20} label={!quiet} />}
      <span className="row-meta">{took}</span>
      <Icon name="chevron" size={16} />
    </a>
  );
}

const FILTERS: Array<{ label: string; status?: ExecutionStatus }> = [
  { label: 'All' },
  { label: 'Running', status: 'RUNNING' },
  { label: 'Waiting', status: 'WAITING' },
  { label: 'Succeeded', status: 'COMPLETED' },
  { label: 'Failed', status: 'FAILED' },
];

export function Executions() {
  // The filter lives in the URL so a reload, a back navigation or a shared link
  // lands on the same view the user had set up.
  const [statusParam, setStatusParam] = useRouteParam('status');
  const status = FILTERS.find((filter) => filter.status === statusParam)?.status;
  const [search, setSearch] = useState('');
  const now = useNow(2000);
  const executions = usePolling(() => api.executions({ status, limit: 100 }), 1500, [status]);
  const routines = usePolling(() => api.routines(), 10_000);
  const byId = new Map((routines.data ?? []).map((routine) => [routine.id, routine]));

  const all = executions.data ?? [];
  const term = search.trim().toLowerCase();
  const visible = term ? all.filter((execution) => execution.routineName.toLowerCase().includes(term)) : all;
  const active = FILTERS.find((filter) => filter.status === status) ?? FILTERS[0];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Runs</h1>
        </div>
      </header>
      <div className="filter-bar">
        <div className="segmented" role="tablist" aria-label="Filter by status">
          {FILTERS.map((filter) => (
            <button key={filter.label} type="button" role="tab" aria-selected={status === filter.status}
              className={status === filter.status ? 'active' : ''} onClick={() => setStatusParam(filter.status ?? null)}>
              {filter.label}
            </button>
          ))}
        </div>
        <div className="search">
          <Icon name="search" size={16} />
          <input type="search" value={search} placeholder="Search" aria-label="Filter by routine"
            onChange={(event) => setSearch(event.target.value)} />
        </div>
        {all.length > 0 && <span className="result-count">{visible.length} {visible.length === 1 ? 'run' : 'runs'}</span>}
      </div>
      <ErrorNote error={executions.error} onRetry={executions.reload} />
      {executions.loading ? <div className="card"><Skeleton lines={5} /></div> : all.length === 0 ? (
        <div className="card">
          <Empty icon="executions" title={status ? `No runs: ${active.label}` : 'No runs yet'}
            action={status
              ? <button type="button" className="btn" onClick={() => setStatusParam(null)}>Show all</button>
              : <a className="btn primary" href="#/routines">Go to routines</a>} />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <Empty icon="search" title={`Nothing matches "${search}"`} action={<button type="button" className="btn" onClick={() => setSearch('')}>Clear search</button>} />
        </div>
      ) : (
        groupByDay(visible, (execution) => execution.createdAt).map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h2 className="group-label">{group.label}</h2>
            <ul className="list">
              {group.items.map((execution) => (
                <li key={execution.id}>
                  <ExecutionRow execution={execution} now={now} routine={byId.get(execution.routineId)} showClock />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

const HEADLINE: Record<ExecutionStatus, string> = {
  PENDING: 'Starting …',
  RUNNING: 'Running …',
  WAITING: 'Waiting to retry',
  COMPLETED: 'Succeeded',
  FAILED: 'Failed',
};

export function ExecutionDetail({ id }: { id: string }) {
  const toast = useToast();
  const now = useNow(500);
  const [rerunning, setRerunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const execution = usePolling(
    async () => {
      const result = await api.execution(id);
      if (TERMINAL_STATUSES.has(result.status)) setFinished(true);
      return result;
    },
    finished ? 0 : 1000,
    [id],
  );
  // for "Run again": is the routine still there and active, and how is it started?
  const routineId = execution.data?.routineId;
  const routineInfo = usePolling(async () => (routineId ? api.routine(routineId) : undefined), 0, [routineId]);

  if (execution.error && !execution.data) {
    return (
      <div className="page">
        <a className="back" href="#/executions"><Icon name="back" size={18} /> Runs</a>
        <ErrorNote error={execution.error} onRetry={execution.reload} />
      </div>
    );
  }
  // Keep the chrome while loading: a bare spinner would drop the way back out.
  if (!execution.data) {
    return (
      <div className="page">
        <a className="back" href="#/executions"><Icon name="back" size={18} /> Runs</a>
        <div className="card"><Skeleton lines={2} /></div>
        <div className="card"><Skeleton lines={4} /></div>
      </div>
    );
  }
  const e = execution.data;
  const routine = routineInfo.data;

  // Same routine, same input: a webhook run is replayed with the body it received.
  async function runAgain() {
    if (!routine) return;
    setRerunning(true);
    try {
      navigate(`/executions/${await startRoutine(routine, e.triggerPayload ?? undefined)}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setRerunning(false);
    }
  }

  const action = e.actions.find((candidate) => candidate.key === selected) ?? null;
  const workers = [...new Set(e.actions.map((candidate) => candidate.processedBy).filter(Boolean))];
  const done = e.actions.filter((candidate) => TERMINAL_ACTION.has(candidate.status)).length;
  const running = !TERMINAL_STATUSES.has(e.status);
  const tone = statusTone(e.status);
  const started = TRIGGER_WORDS[e.trigger];

  return (
    <div className="page">
      <a className="back" href={`#/routines/${e.routineId}`}><Icon name="back" size={18} /> {e.routineName}</a>

      <header className="run-hero">
        <span className={`big-status tone-${tone}`} aria-hidden="true">
          {tone === 'busy' ? <span className="status-spin" /> : <Icon name={tone === 'ok' ? 'check' : tone === 'err' ? 'x' : 'retry'} size={34} />}
        </span>
        <div className="grow">
          <span className="eyebrow">{e.routineName}</span>
          <h1 aria-live="polite">{HEADLINE[e.status]}</h1>
          <p>{started} · {dateTime(e.createdAt)} · <span className="tabular">{between(e.startedAt ?? e.createdAt, e.finishedAt, now)}</span></p>
        </div>
        {!running && routine?.active && (
          <button type="button" className="btn tinted" disabled={rerunning} onClick={() => void runAgain()}>
            {rerunning ? <span className="spinner" /> : <Icon name="retry" size={16} />} Run again
          </button>
        )}
      </header>

      {running && e.actions.length > 0 && (
        <div className="card">
          <div className="progress-label"><span>{done} of {e.actions.length} steps</span><span>{Math.round((done / e.actions.length) * 100)} %</span></div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={e.actions.length} aria-valuenow={done} aria-label="Progress">
            <span style={{ width: `${(done / e.actions.length) * 100}%` }} />
          </div>
        </div>
      )}

      {e.error && <p className="error-note"><Icon name="warning" size={18} /> {e.error}</p>}
      <RunOutcome actions={e.actions} status={e.status} />

      <Section id="flow-title" title="Steps">
        <div>
          <ActionFlowForRun e={e} now={now} selected={selected} onSelect={(key) => setSelected(key === selected ? null : key)} />
          {action && (
            <div className="inspector" aria-live="polite">
              <div className="inspector-head">
                <h3>{actionLabel(action.type)}</h3>
                <StatusBadge status={action.status} />
              </div>
              <dl className="kv">
                <dt>Attempts</dt><dd>{action.attempts}</dd>
                <dt>Duration</dt><dd>{action.dispatchedAt ? between(action.dispatchedAt, action.finishedAt, now) : '–'}</dd>
                <dt>Worker</dt><dd><code>{action.processedBy ?? '–'}</code></dd>
                <dt>Type</dt><dd><code>{action.type}</code> · <code>{action.key}</code></dd>
                <dt>ID</dt><dd><code>{action.id}</code> <CopyButton value={action.id} what="ID" /></dd>
              </dl>
              {action.error && <p className="error-note">{action.error}</p>}
              <div className="grid-2">
                <div><h4>Input</h4><JsonBlock value={action.params} /></div>
                <div><h4>Output</h4>{action.output ? <JsonBlock value={action.output} /> : <p className="muted small">–</p>}</div>
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* The distributed-systems story – kept whole, clearly labelled, one click away. */}
      <details className="under-hood">
        <summary>
          <span className="glyph tint-grey" aria-hidden="true"><Icon name="stack" size={20} /></span>
          <span className="grow">
            <strong className="block">Under the hood</strong>
            <span className="muted small">Status history, event log, tracing</span>
          </span>
          <Icon name="chevron" size={18} />
        </summary>
        <div className="under-hood-body">
          {e.triggerPayload && (
            <div>
              <h3>Webhook data</h3>
              <JsonBlock value={e.triggerPayload} />
            </div>
          )}
          <div>
            <h3>Status history</h3>
            <Pipeline status={e.status} log={e.log} />
          </div>
          <div className="grid-2 wide-left">
            <div>
              <h3>Event log</h3>
              <Timeline log={e.log} />
            </div>
            <div>
              <h3>Tracing</h3>
              <dl className="kv">
                <dt>Execution</dt><dd><code>{e.id}</code> <CopyButton value={e.id} what="execution ID" /></dd>
                <dt>Correlation</dt><dd><code>{e.correlationId}</code> <CopyButton value={e.correlationId} what="correlation ID" /></dd>
                <dt>Trace</dt><dd>{e.traceId ? <><code>{e.traceId}</code> <CopyButton value={e.traceId} what="trace ID" /></> : '–'}</dd>
              </dl>
              <p className="muted small">Logs from all services</p>
              <div className="command"><code>scripts/demo.sh trace {e.correlationId}</code><CopyButton value={`scripts/demo.sh trace ${e.correlationId}`} what="command" /></div>
              {workers.length > 0 && (
                <>
                  <p className="muted small">Worker instances</p>
                  <div className="chips" style={{ margin: '6px 0 14px' }}>
                    {workers.map((worker) => {
                      const parts = splitInstance(worker ?? null);
                      return <span key={worker} className="chip" title={worker ?? ''}>{parts?.service}@{parts?.instance}</span>;
                    })}
                  </div>
                </>
              )}
              {e.traceId && (
                <a className="btn tinted" href={`${JAEGER_URL}/trace/${e.traceId}`} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" size={16} /> Open in Jaeger
                </a>
              )}
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

const TERMINAL_ACTION = new Set(['COMPLETED', 'FAILED', 'SKIPPED']);

function ActionFlowForRun({ e, now, selected, onSelect }: { e: Detail; now: number; selected: string | null; onSelect: (key: string) => void }) {
  return (
    <ActionFlow
      actions={e.actions}
      selected={selected}
      onSelect={onSelect}
      stateOf={(action) => action.status}
      aside={(action) => (
        <span className="aside">
          <StatusIcon status={action.status} size={20} label={action.status !== 'COMPLETED'} />
          <span className="muted small tabular">
            {action.attempts > 1 && <>attempt {action.attempts} · </>}
            {action.dispatchedAt ? between(action.dispatchedAt, action.finishedAt, now) : ''}
          </span>
        </span>
      )}
    />
  );
}
