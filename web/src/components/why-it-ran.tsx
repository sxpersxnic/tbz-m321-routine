/**
 * "Why did this run?" on an event-triggered run (07 §5.6): the event and what it said, the routine's
 * trigger, trigger-service's decision for this event, and its recent decisions for the routine –
 * which also answer "why didn't it run that other time?".
 */
import { Fragment } from 'react';
import { api } from '../api.ts';
import { useCatalog } from '../catalog/store.ts';
import { useRefNames } from '../catalog/ref-names.ts';
import { dateTime, describeTrigger, relative } from '../format.ts';
import { usePolling } from '../hooks.ts';
import { DECISION_WORDS, eventFacts, eventWords } from '../lib/event-trigger.ts';
import type { Execution, Routine } from '../types.ts';
import { ErrorNote, Skeleton } from './ui.tsx';

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Event-chain limit (trigger-service MAX_EVENT_DEPTH). */
const MAX_DEPTH = 5;

export function WhyItRan({ e, routine, now }: { e: Execution & { triggerEvent: NonNullable<Execution['triggerEvent']> }; routine: Routine | undefined; now: number }) {
  const catalog = useCatalog();
  const nameOf = useRefNames(true);
  const log = usePolling(() => api.triggerLog(e.routineId), 0, [e.routineId]);
  const facts = eventFacts(catalog, e.triggerEvent);
  const decision = log.data?.find((candidate) => candidate.eventMessageId === e.triggerEvent.eventMessageId);
  const others = log.data?.filter((candidate) => candidate.eventMessageId !== e.triggerEvent.eventMessageId).slice(0, 5) ?? [];

  return (
    <div className="why-it-ran">
      <p className="why-line">
        <strong>{catalog.trigger(e.triggerEvent.event)?.label ?? eventWords(e.triggerEvent.event)}</strong>
        {routine?.trigger.type === 'event' && <> – and this routine starts {describeTrigger(routine.trigger, catalog, nameOf).replace(/^When/, 'when')}.</>}
      </p>
      {facts.length > 0 && (
        <dl className="kv">
          {facts.map((fact) => (
            <Fragment key={fact.label}><dt>{fact.label}</dt><dd>{ISO_TIME.test(fact.value) ? dateTime(fact.value) : fact.value}</dd></Fragment>
          ))}
        </dl>
      )}
      {(e.depth ?? 0) > 0 && (
        <p className="why-line muted small">
          Another routine's step caused this event – {e.depth} of at most {MAX_DEPTH} routines in a row that start each other.
        </p>
      )}
      {log.error && !log.data && <ErrorNote error={log.error} onRetry={log.reload} />}
      {!log.data && !log.error && <Skeleton lines={2} />}
      {log.data && (
        <>
          <p className="why-line small">{decision ? DECISION_WORDS[decision.outcome] : 'Matched – the routine was started'}</p>
          {others.length > 0 && (
            <>
              <h4 className="why-heading">Earlier events</h4>
              <ul className="decision-list">
                {others.map((other) => (
                  <li key={`${other.eventMessageId}-${other.at}`}>
                    <span className={`decision decision-${other.outcome}`}>{DECISION_WORDS[other.outcome]}</span>
                    <span className="muted small"> · {eventWords(other.event)} · {relative(other.at, now)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
