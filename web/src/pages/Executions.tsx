import { useState } from 'react';
import { api } from '../api.ts';
import { Pipeline, StepFlow, Timeline } from '../components/execution.tsx';
import { Card, CopyButton, Empty, ErrorNote, Icon, JsonBlock, Loading, StatusBadge } from '../components/ui.tsx';
import { between, dateTime, JAEGER_URL, relative, splitInstance } from '../format.ts';
import { useNow, usePolling } from '../hooks.ts';
import { TERMINAL_STATUSES, type Execution, type ExecutionStatus } from '../types.ts';

export function ExecutionRow({ execution, now, hideName }: { execution: Execution; now: number; hideName?: boolean }) {
  const running = !TERMINAL_STATUSES.has(execution.status);
  return (
    <a href={`#/executions/${execution.id}`} className={`exec-row status-row-${execution.status}`}>
      <StatusBadge status={execution.status} />
      <span className="grow">
        {!hideName && <strong>{execution.routineName}</strong>}
        <span className="muted small block">
          {execution.trigger === 'schedule' ? 'Zeitplan' : 'Manuell'} · {relative(execution.createdAt, now)}
        </span>
      </span>
      <span className="muted small tabular">{running ? between(execution.startedAt ?? execution.createdAt, null, now) : between(execution.startedAt, execution.finishedAt)}</span>
    </a>
  );
}

const FILTERS: Array<{ label: string; status?: ExecutionStatus }> = [
  { label: 'Alle' },
  { label: 'Laufend', status: 'RUNNING' },
  { label: 'Wartend', status: 'WAITING' },
  { label: 'Abgeschlossen', status: 'COMPLETED' },
  { label: 'Fehlgeschlagen', status: 'FAILED' },
];

export function Executions() {
  const [status, setStatus] = useState<ExecutionStatus>();
  const now = useNow(2000);
  const executions = usePolling(() => api.executions({ status, limit: 100 }), 1500, [status]);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Ausführungen</h1>
          <p className="muted">Jede Ausführung einer Routine – live aktualisiert.</p>
        </div>
      </header>
      <div className="segmented" role="tablist">
        {FILTERS.map((filter) => (
          <button key={filter.label} type="button" role="tab" aria-selected={status === filter.status}
            className={status === filter.status ? 'active' : ''} onClick={() => setStatus(filter.status)}>
            {filter.label}
          </button>
        ))}
      </div>
      <ErrorNote error={executions.error} />
      <Card>
        {executions.loading ? <Loading /> : executions.data?.length === 0 ? <Empty>Keine Ausführungen.</Empty> : (
          <div className="rows">{executions.data?.map((execution) => <ExecutionRow key={execution.id} execution={execution} now={now} />)}</div>
        )}
      </Card>
    </div>
  );
}

export function ExecutionDetail({ id }: { id: string }) {
  const now = useNow(500);
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

  if (execution.error && !execution.data) return <div className="page"><ErrorNote error={execution.error} /></div>;
  if (!execution.data) return <div className="page"><Loading /></div>;
  const e = execution.data;
  const action = e.actions.find((candidate) => candidate.key === selected) ?? null;
  const workers = [...new Set(e.actions.map((candidate) => candidate.processedBy).filter(Boolean))];

  return (
    <div className="page">
      <a className="back" href={`#/routines/${e.routineId}`}><Icon name="back" size={16} /> {e.routineName}</a>
      <header className="page-head">
        <div>
          <h1>{e.routineName} <StatusBadge status={e.status} /></h1>
          <p className="muted">
            {e.trigger === 'schedule' ? `Durch Zeitplan gestartet (${dateTime(e.scheduledFor)})` : 'Manuell gestartet'} · {dateTime(e.createdAt)} · Dauer{' '}
            <span className="tabular">{between(e.startedAt ?? e.createdAt, e.finishedAt, now)}</span>
          </p>
        </div>
        {e.traceId && (
          <a className="btn ghost" href={`${JAEGER_URL}/trace/${e.traceId}`} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={16} /> Trace in Jaeger
          </a>
        )}
      </header>

      <Pipeline status={e.status} log={e.log} />
      {e.error && <p className="error-note">{e.error}</p>}

      <Card title="Ablauf" actions={<span className="muted small">Aktion anklicken für Details</span>}>
        <StepFlow items={e.actions} selected={selected} onSelect={(key) => setSelected(key === selected ? null : key)} now={now} />
        {action && (
          <div className="inspector">
            <div className="inspector-head">
              <h3>{action.key} <span className="muted">· {action.type}</span></h3>
              <StatusBadge status={action.status} />
            </div>
            <dl className="kv">
              <dt>Action-ID</dt><dd><code>{action.id}</code> <CopyButton value={action.id} /></dd>
              <dt>Versuche</dt><dd>{action.attempts}</dd>
              <dt>Verarbeitet von</dt><dd>{action.processedBy ?? '–'}</dd>
              <dt>Übergeben</dt><dd>{dateTime(action.dispatchedAt)}</dd>
              <dt>Fertig</dt><dd>{dateTime(action.finishedAt)}</dd>
            </dl>
            {action.error && <p className="error-note">{action.error}</p>}
            <div className="grid-2">
              <div><h4>Parameter (aufgelöst)</h4><JsonBlock value={action.params} /></div>
              <div><h4>Ergebnis</h4>{action.output ? <JsonBlock value={action.output} /> : <p className="muted small">noch kein Ergebnis</p>}</div>
            </div>
          </div>
        )}
      </Card>

      <div className="grid-2 wide-left">
        <Card title="Verlauf">
          <Timeline log={e.log} />
        </Card>
        <Card title="Nachvollziehbarkeit">
          <dl className="kv">
            <dt>Execution-ID</dt><dd><code>{e.id}</code> <CopyButton value={e.id} /></dd>
            <dt>Correlation-ID</dt><dd><code>{e.correlationId}</code> <CopyButton value={e.correlationId} /></dd>
            <dt>Trace-ID</dt><dd>{e.traceId ? <><code>{e.traceId}</code> <CopyButton value={e.traceId} /></> : '–'}</dd>
          </dl>
          <p className="muted small">Logs aller Services zu dieser Ausführung:</p>
          <div className="command"><code>scripts/demo.sh trace {e.correlationId}</code><CopyButton value={`scripts/demo.sh trace ${e.correlationId}`} /></div>
          {workers.length > 0 && (
            <>
              <p className="muted small">Beteiligte Service-Instanzen:</p>
              <div className="chips">
                {workers.map((worker) => {
                  const parts = splitInstance(worker ?? null);
                  return <span key={worker} className="chip" title={worker ?? ''}>{parts?.service}@{parts?.instance}</span>;
                })}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
