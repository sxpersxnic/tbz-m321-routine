import { Fragment } from 'react';
import { actionIcon, actionLabel } from '../action-forms.ts';
import { between, splitInstance, time } from '../format.ts';
import type { ActionStatus, ExecutionLogEntry, ExecutionStatus } from '../types.ts';
import { StatusBadge } from './ui.tsx';

// ---------------------------------------------------------------- step flow (definition preview + live execution)

export interface FlowItem {
  key: string;
  type: string;
  step: number;
  status?: ActionStatus;
  attempts?: number;
  processedBy?: string | null;
  error?: string | null;
  dispatchedAt?: string | null;
  finishedAt?: string | null;
}

export function StepFlow({ items, selected, onSelect, now }: {
  items: FlowItem[];
  selected?: string | null;
  onSelect?: (key: string) => void;
  now?: number;
}) {
  const steps = [...new Set(items.map((item) => item.step))].sort((a, b) => a - b);
  if (steps.length === 0) return <p className="empty">Noch keine Aktionen.</p>;
  return (
    <div className="flow" role="list">
      {steps.map((step, index) => {
        const lane = items.filter((item) => item.step === step);
        return (
          <Fragment key={step}>
            {index > 0 && <div className="flow-arrow" aria-hidden="true">→</div>}
            <div className="flow-step" role="listitem">
              <div className="flow-step-label">
                Schritt {step}
                {lane.length > 1 && <span className="muted"> · parallel</span>}
              </div>
              {lane.map((item) => {
                const instance = splitInstance(item.processedBy ?? null);
                const Tag = onSelect ? 'button' : 'div';
                return (
                  <Tag
                    key={item.key}
                    type={onSelect ? 'button' : undefined}
                    className={`flow-node ${item.status ? `node-${item.status}` : ''} ${selected === item.key ? 'selected' : ''}`}
                    onClick={onSelect ? () => onSelect(item.key) : undefined}
                  >
                    <div className="flow-node-head">
                      <span className="flow-icon" aria-hidden="true">{actionIcon(item.type)}</span>
                      <span className="flow-key">{item.key}</span>
                      {item.status && <StatusBadge status={item.status} />}
                    </div>
                    <div className="flow-type">{actionLabel(item.type)}</div>
                    {item.status && (
                      <div className="flow-meta">
                        {instance && <span className="chip" title={item.processedBy ?? ''}>{instance.service}@{instance.instance}</span>}
                        {(item.attempts ?? 0) > 1 && <span className="chip warn">{item.attempts} Versuche</span>}
                        {item.dispatchedAt && <span className="muted">{between(item.dispatchedAt, item.finishedAt ?? null, now)}</span>}
                      </div>
                    )}
                    {item.error && <div className="flow-error">{item.error}</div>}
                  </Tag>
                );
              })}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- status pipeline

export function Pipeline({ status, log }: { status: ExecutionStatus; log: ExecutionLogEntry[] }) {
  const waited = status === 'WAITING' || log.some((entry) => entry.kind === 'WAITING');
  const stages: ExecutionStatus[] = ['PENDING', 'RUNNING', ...(waited ? (['WAITING'] as const) : []), status === 'FAILED' ? 'FAILED' : 'COMPLETED'];
  const order: Record<ExecutionStatus, number> = { PENDING: 0, RUNNING: 1, WAITING: 2, COMPLETED: 3, FAILED: 3 };
  return (
    <ol className="pipeline" aria-label="Status der Ausführung">
      {stages.map((stage) => {
        const state = stage === status ? 'current' : order[stage] < order[status] || (stage === 'WAITING' && waited && status !== 'WAITING') ? 'done' : 'todo';
        return (
          <li key={stage} className={`stage ${state} stage-${stage}`}>
            <span className="stage-dot" />
            {stage}
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

export function Timeline({ log }: { log: ExecutionLogEntry[] }) {
  const start = log[0] ? new Date(log[0].at).getTime() : 0;
  return (
    <ol className="timeline">
      {log.map((entry, index) => (
        <li key={index} className={`tone-${KIND_TONE[entry.kind] ?? 'neutral'}`}>
          <span className="timeline-time" title={time(entry.at)}>+{((new Date(entry.at).getTime() - start) / 1000).toFixed(2)} s</span>
          <span className="timeline-kind">{entry.kind.replace('ACTION_', '')}</span>
          <span className="timeline-text">
            {entry.actionKey && <strong>{entry.actionKey} </strong>}
            {entry.message}
          </span>
        </li>
      ))}
    </ol>
  );
}
