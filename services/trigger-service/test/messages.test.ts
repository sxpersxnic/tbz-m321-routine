/** trigger-service's messages against their contracts (contracts/schemas). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { contractErrors } from '../../../contracts/validate.ts';
import { startRoutineRequested } from '../src/messages.ts';

describe('StartRoutineRequested (05 §4.3)', () => {
  const eventMessageId = randomUUID();
  const message = startRoutineRequested({
    routineId: randomUUID(),
    ownerId: randomUUID(),
    routineVersion: 3,
    event: { event: 'task.completed', eventMessageId, data: { taskId: randomUUID(), title: 'Pay rent' } },
    depth: 1,
    correlationId: randomUUID(),
  });

  it('conforms to its schema and goes to routine.commands with routing key routine.start', () => {
    assert.deepEqual(contractErrors('start-routine-requested.v1.schema.json', message.envelope), []);
    assert.equal(message.exchange, 'routine.commands');
    assert.equal(message.routingKey, 'routine.start');
  });

  it('keys the start on the event, so a redelivered event starts no second run', () => {
    const data = message.envelope.data as { idempotencyKey: string; trigger: { eventMessageId: string } };
    assert.equal(data.idempotencyKey, `event:${eventMessageId}`);
    assert.equal(data.trigger.eventMessageId, eventMessageId);
  });
});
