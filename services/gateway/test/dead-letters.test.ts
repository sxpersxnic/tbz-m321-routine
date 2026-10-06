import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discardDeadLetters, listDeadLetters, replayDeadLetters, type DeadLetterError, type Management, type RawMessage } from '../src/dead-letters.ts';

const message = (id: string, headers: Record<string, unknown> = { 'x-error': 'boom', 'x-attempts': 3 }): RawMessage => ({
  routing_key: 'execution.completed',
  payload: Buffer.from(JSON.stringify({ messageId: id, type: 'ExecutionCompleted', data: {} })).toString('base64'),
  payload_encoding: 'base64',
  properties: { message_id: id, headers },
});

/** An in-memory RabbitMQ management API: queues are arrays, the head is index 0. */
function fakeRabbit(queues: Record<string, RawMessage[]>, options: { beforeRemove?: (queue: string) => void } = {}) {
  const decodeQueue = (path: string) => decodeURIComponent(path.split('/')[4]);
  const api: Management = {
    async get<T>(path: string) {
      if (path.startsWith('/api/queues/%2F?')) return Object.entries(queues).map(([name, messages]) => ({ name, messages: messages.length })) as T;
      return { messages: queues[decodeQueue(path)]?.length ?? 0 } as T;
    },
    async post<T>(path: string, body: unknown) {
      const request = body as { count?: number; ackmode?: string; routing_key?: string; properties?: RawMessage['properties']; payload?: string };
      if (path.endsWith('/get')) {
        const queue = queues[decodeQueue(path)];
        if (request.ackmode === 'reject_requeue_true') return queue.slice(0, request.count) as T;
        options.beforeRemove?.(decodeQueue(path));
        return queue.splice(0, 1) as T;
      }
      const target = queues[request.routing_key ?? ''];
      if (!target) return { routed: false } as T;
      target.push({ routing_key: request.routing_key ?? '', payload: request.payload ?? '', payload_encoding: 'base64', properties: request.properties ?? {} });
      return { routed: true } as T;
    },
  };
  return api;
}

const ids = (messages: RawMessage[]) => messages.map((item) => item.properties.message_id);

describe('dead letters (port of scripts/replay-dlq.sh)', () => {
  it('lists every DLQ with a peek that leaves the messages where they are', async () => {
    const queues = { 'task-service.actions': [], 'task-service.actions.dlq': [message('a'), message('b')], 'routine-service.triggers.dlq': [] };
    const list = await listDeadLetters(fakeRabbit(queues));
    assert.deepEqual(list.map((queue) => [queue.queue, queue.workQueue, queue.count]), [
      ['routine-service.triggers.dlq', 'routine-service.triggers', 0],
      ['task-service.actions.dlq', 'task-service.actions', 2],
    ]);
    assert.deepEqual(list[1].sample.map((letter) => [letter.messageId, letter.type, letter.error, letter.attempts]), [
      ['a', 'ExecutionCompleted', 'boom', 3],
      ['b', 'ExecutionCompleted', 'boom', 3],
    ]);
    assert.equal(queues['task-service.actions.dlq'].length, 2, 'a peek removes nothing');
  });

  it('replays all messages into the work queue without their failure headers', async () => {
    const queues = { 'q': [] as RawMessage[], 'q.dlq': [message('a'), message('b')] };
    assert.deepEqual(await replayDeadLetters(fakeRabbit(queues), 'q.dlq'), { moved: 2 });
    assert.deepEqual(ids(queues.q), ['a', 'b']);
    assert.equal(queues['q.dlq'].length, 0);
    assert.deepEqual(queues.q[0].properties.headers, {}, 'x-error and x-attempts are gone');
  });

  it('stops when the work queue does not accept messages, losing nothing', async () => {
    const queues = { 'q.dlq': [message('a')] };
    await assert.rejects(replayDeadLetters(fakeRabbit(queues), 'q.dlq'), (error: DeadLetterError) => error.status === 409 && error.moved === 0);
    assert.deepEqual(ids(queues['q.dlq']), ['a']);
  });

  it('aborts on a concurrent change and puts the message it removed back', async () => {
    const queues = { 'q': [] as RawMessage[], 'q.dlq': [message('a'), message('b'), message('c')] };
    let once = true;
    // another replay takes the head between our peek and our remove
    const api = fakeRabbit(queues, { beforeRemove: (queue) => { if (queue === 'q.dlq' && once) { once = false; queues.q.push(...queues['q.dlq'].splice(0, 1)); } } });
    await assert.rejects(replayDeadLetters(api, 'q.dlq'), (error: DeadLetterError) => error.status === 409 && /changed concurrently/.test(error.message));
    // a: copied by us and moved by the other one (a duplicate – consumers are idempotent); b: removed by us, put back
    assert.deepEqual(ids(queues.q), ['a', 'a']);
    assert.deepEqual(ids(queues['q.dlq']), ['c', 'b'], 'nothing lost');
  });

  it('discards only the chosen messages and keeps the order of the rest', async () => {
    const queues = { 'q.dlq': [message('a'), message('b'), message('c'), message('d')] };
    assert.deepEqual(await discardDeadLetters(fakeRabbit(queues), 'q.dlq', ['b', 'd']), { discarded: 2 });
    assert.deepEqual(ids(queues['q.dlq']), ['a', 'c']);
  });

  it('refuses names that are not dead letter queues', async () => {
    await assert.rejects(replayDeadLetters(fakeRabbit({}), 'task-service.actions'), (error: DeadLetterError) => error.status === 400);
    await assert.rejects(discardDeadLetters(fakeRabbit({}), '../x.dlq', []), (error: DeadLetterError) => error.status === 400);
  });
});
