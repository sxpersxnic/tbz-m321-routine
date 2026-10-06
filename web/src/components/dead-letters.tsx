import { useState } from 'react';
import { api } from '../api.ts';
import { relative } from '../format.ts';
import { useNow, usePolling } from '../hooks.ts';
import type { DeadLetterQueue } from '../types.ts';
import { useToast } from './toast.tsx';
import { ConfirmDialog, Disclosure, Icon, JsonBlock } from './ui.tsx';

/** Each DLQ in words (02-experience §16): what its messages are, by the queue they failed in. */
const QUEUE_WORDS: Record<string, { one: string; many: string }> = {
  'task-service.actions.dlq': { one: 'task step could not be processed', many: 'task steps could not be processed' },
  'notification-service.actions.dlq': { one: 'notification could not be delivered', many: 'notifications could not be delivered' },
  'integration-worker.actions.dlq': { one: 'web, weather or e-mail step failed for good', many: 'web, weather or e-mail steps failed for good' },
  'notification-service.execution-events.dlq': { one: 'run result could not be read by the inbox', many: 'run results could not be read by the inbox' },
  'routine-service.action-results.dlq': { one: 'step result could not be applied', many: 'step results could not be applied' },
  'routine-service.triggers.dlq': { one: 'run could not be started', many: 'runs could not be started' },
  'routine-service.commands.dlq': { one: 'event-triggered run could not be started', many: 'event-triggered runs could not be started' },
  'trigger-service.events.dlq': { one: 'event could not be checked against your routines', many: 'events could not be checked against your routines' },
  'trigger-service.routines.dlq': { one: 'routine change did not reach the event triggers', many: 'routine changes did not reach the event triggers' },
};

const describe = (queue: DeadLetterQueue) => {
  const words = QUEUE_WORDS[queue.queue];
  return words ? `${queue.count} ${queue.count === 1 ? words.one : words.many}` : `${queue.count} in ${queue.queue}`;
};

/**
 * Dead letters for admins: what failed for good, per queue, with Replay (back into the work queue,
 * e.g. after a consumer fix) and Discard. The gateway does the work, like scripts/replay-dlq.sh.
 */
export function DeadLetters() {
  const toast = useToast();
  const now = useNow(10_000);
  const list = usePolling(() => api.deadLetters(), 5_000);
  const [busy, setBusy] = useState<string>();
  const [discarding, setDiscarding] = useState<{ queue: string; messageId: string; type: string | null }>();

  async function replay(queue: DeadLetterQueue) {
    setBusy(queue.queue);
    try {
      const { moved } = await api.replayDeadLetters(queue.queue);
      // the broker's queue stats lag about a second behind – show the result now, the next poll confirms it
      list.mutate((current) =>
        current.map((candidate) => (candidate.queue === queue.queue ? { ...candidate, count: Math.max(0, candidate.count - moved), sample: candidate.sample.slice(moved) } : candidate)),
      );
      toast(`${moved} replayed into ${queue.workQueue}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      list.reload();
    } finally {
      setBusy(undefined);
    }
  }

  async function discard() {
    if (!discarding) return;
    const { queue, messageId } = discarding;
    setDiscarding(undefined);
    setBusy(queue);
    try {
      const { discarded } = await api.discardDeadLetters(queue, [messageId]);
      list.mutate((current) =>
        current.map((candidate) =>
          candidate.queue === queue
            ? { ...candidate, count: Math.max(0, candidate.count - discarded), sample: candidate.sample.filter((letter) => letter.messageId !== messageId) }
            : candidate,
        ),
      );
      toast('Discarded');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
      list.reload();
    } finally {
      setBusy(undefined);
    }
  }

  const full = (list.data ?? []).filter((queue) => queue.count > 0);
  return (
    <div className="card">
      <div className="card-head"><h2 id="dead-letters">Dead letters</h2></div>
      {list.error && <p className="error-note">{list.error.message}</p>}
      {list.data && full.length === 0 && <p className="muted small">Empty</p>}
      <ul className="dead-letters" aria-labelledby="dead-letters">
        {full.map((queue) => (
          <li key={queue.queue}>
            <div className="dead-letter-head">
              <span className="grow">
                <strong className="block">{describe(queue)}</strong>
                <span className="muted small mono">{queue.queue}</span>
              </span>
              <button type="button" className="btn small tinted" disabled={busy !== undefined} onClick={() => void replay(queue)}>
                {busy === queue.queue ? <span className="spinner" /> : <Icon name="retry" size={14} />} Replay
              </button>
            </div>
            <Disclosure summary={queue.count > queue.sample.length ? `First ${queue.sample.length} messages` : 'Messages'}>
              <ul className="dead-letter-messages">
                {queue.sample.map((letter, index) => (
                  <li key={letter.messageId ?? index}>
                    <div className="dead-letter-message">
                      <span className="grow">
                        <strong className="mono small">{letter.type ?? letter.routingKey}</strong>
                        {letter.error && <span className="block small">{letter.error}</span>}
                        <span className="block muted small">
                          {[letter.attempts !== null && `${letter.attempts} attempt${letter.attempts === 1 ? '' : 's'}`, letter.failedAt && relative(letter.failedAt, now)].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {letter.messageId && (
                        <button type="button" className="btn small danger" disabled={busy !== undefined}
                          onClick={() => setDiscarding({ queue: queue.queue, messageId: letter.messageId as string, type: letter.type })}>
                          Discard
                        </button>
                      )}
                    </div>
                    <Disclosure summary="Raw message"><JsonBlock value={letter.body} /></Disclosure>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </li>
        ))}
      </ul>
      <ConfirmDialog open={discarding !== undefined} danger title="Discard this message?" confirmLabel="Discard"
        onCancel={() => setDiscarding(undefined)} onConfirm={() => void discard()}>
        <p>{discarding?.type ?? 'The message'} is removed from {discarding?.queue} and never processed.</p>
      </ConfirmDialog>
    </div>
  );
}
