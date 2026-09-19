import { time } from '../format.ts';
import type { ExecutionLogEntry, ExecutionStatus } from '../types.ts';
import { statusLabel } from './ui.tsx';

// ---------------------------------------------------------------- status pipeline

export function Pipeline({ status, log }: { status: ExecutionStatus; log: ExecutionLogEntry[] }) {
  const waited = status === 'WAITING' || log.some((entry) => entry.kind === 'WAITING');
  const stages: ExecutionStatus[] = ['PENDING', 'RUNNING', ...(waited ? (['WAITING'] as const) : []), status === 'FAILED' ? 'FAILED' : 'COMPLETED'];
  const order: Record<ExecutionStatus, number> = { PENDING: 0, RUNNING: 1, WAITING: 2, COMPLETED: 3, FAILED: 3 };
  return (
    <ol className="pipeline" aria-label="Status history">
      {stages.map((stage) => {
        const state = stage === status ? 'current' : order[stage] < order[status] || (stage === 'WAITING' && waited && status !== 'WAITING') ? 'done' : 'todo';
        return (
          <li key={stage} className={`stage ${state} stage-${stage}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="stage-dot" />
            {statusLabel(stage)}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- timeline

const KIND_TONE: Record<string, string> = {
  COMPLETED: 'ok',
  ACTION_COMPLETED: 'ok',
  FAILED: 'err',
  ACTION_FAILED: 'err',
  ACTION_RETRY: 'warn',
  WAITING: 'warn',
  RUNNING: 'info',
  ACTION_DISPATCHED: 'info',
};

// The log kinds emitted by routine-service. The entry text already names the
// action, so these read as short verbs rather than repeating "action".
const KIND_LABELS: Record<string, string> = {
  TRIGGERED: 'Triggered',
  STARTED: 'Started',
  RUNNING: 'Running',
  WAITING: 'Waiting',
  COMPLETED: 'Done',
  FAILED: 'Failed',
  ACTION_DISPATCHED: 'Dispatched',
  ACTION_COMPLETED: 'Completed',
  ACTION_FAILED: 'Failed',
  ACTION_RETRY: 'Retry',
};

export function Timeline({ log }: { log: ExecutionLogEntry[] }) {
  const start = log[0] ? new Date(log[0].at).getTime() : 0;
  return (
    <ol className="timeline">
      {log.map((entry, index) => (
        <li key={index} className={`tone-${KIND_TONE[entry.kind] ?? 'neutral'}`}>
          <span className="timeline-time" title={time(entry.at)}>+{((new Date(entry.at).getTime() - start) / 1000).toFixed(2)} s</span>
          <span className="timeline-kind">{KIND_LABELS[entry.kind] ?? entry.kind.replace('ACTION_', '')}</span>
          <span className="timeline-text">
            {entry.actionKey && <strong>{entry.actionKey} </strong>}
            {entry.message}
          </span>
        </li>
      ))}
    </ol>
  );
}
