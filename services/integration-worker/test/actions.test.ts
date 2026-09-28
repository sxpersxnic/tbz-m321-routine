import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { PermanentError, TransientError, validateManifest } from '@routine/service-kit';
import { contractErrors } from '../../../contracts/validate.ts';
import { executeAction, statusErrorCode, type ActionEnvironment } from '../src/actions.ts';
import { actionCompleted, actionFailed } from '../src/messages.ts';
import { CONNECTIONS_MANIFEST } from '../src/manifest.ts';

let server: Server;
let baseUrl: string;
const seenKeys: string[] = [];

before(async () => {
  server = createServer((request, response) => {
    seenKeys.push(String(request.headers['idempotency-key']));
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: url.searchParams.get('to') ?? '/' });
      response.end();
      return;
    }
    if (url.pathname === '/mail/messages') {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ messageId: 'msg-1', acceptedAt: '2026-09-19T08:00:00.000Z' }));
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => response.end('{}'), 300);
      return;
    }
    if (url.pathname === '/huge') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`[${'1,'.repeat(1024 * 1024)}1]`);
      return;
    }
    const status = Number(url.searchParams.get('status') ?? 200);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ city: 'Bern', temperatureC: 20, condition: 'sonnig', ok: status < 400 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const environment = (): ActionEnvironment => ({ actionId: randomUUID(), externalApiUrl: baseUrl, allowedHosts: ['127.0.0.1'], timeoutMs: 2_000 });

describe('integration-worker actions', () => {
  it('sends an e-mail to one or more recipients', async () => {
    const output = await executeAction('email.send', { to: 'ada@example.com; bob@example.com', subject: 'Hi', body: 'Hello' }, environment());
    assert.deepEqual(output, { messageId: 'msg-1', to: 'ada@example.com, bob@example.com', subject: 'Hi', sentAt: '2026-09-19T08:00:00.000Z' });
  });

  it('rejects unusable e-mails permanently', async () => {
    await assert.rejects(executeAction('email.send', { to: 'not-an-address', subject: 'Hi' }, environment()), PermanentError);
    await assert.rejects(executeAction('email.send', { to: 'ada@example.com' }, environment()), PermanentError);
    await assert.rejects(executeAction('email.send', { subject: 'Hi' }, environment()), PermanentError);
  });

  it('weather.get returns a summary and sends the actionId as idempotency key', async () => {
    const env = environment();
    const output = await executeAction('weather.get', { city: 'Bern' }, env);
    assert.equal(output.summary, 'Bern: sonnig, 20 °C');
    assert.equal(seenKeys.at(-1), env.actionId);
    assert.deepEqual(contractErrors('action-completed.v1.schema.json', actionCompleted({ actionId: env.actionId, executionId: randomUUID(), actionType: 'weather.get' }, output, 'w@1', false)), []);
  });

  it('classifies HTTP failures: 5xx/429 transient, other 4xx permanent', async () => {
    await assert.rejects(executeAction('http.request', { url: `${baseUrl}/?status=503` }, environment()), TransientError);
    await assert.rejects(executeAction('http.request', { url: `${baseUrl}/?status=429` }, environment()), TransientError);
    await assert.rejects(executeAction('http.request', { url: `${baseUrl}/?status=404` }, environment()), PermanentError);
  });

  it('treats unreachable hosts as transient', async () => {
    await assert.rejects(executeAction('http.request', { url: 'http://127.0.0.1:9/' }, environment()), TransientError);
  });

  it('maps HTTP statuses to error codes (05-messaging §6)', () => {
    const table: Array<[number, string]> = [
      [400, 'INVALID_PARAMS'],
      [401, 'UNAUTHORIZED'],
      [403, 'UNAUTHORIZED'],
      [404, 'NOT_FOUND'],
      [408, 'TIMEOUT'],
      [410, 'NOT_FOUND'],
      [422, 'INVALID_PARAMS'],
      [429, 'RATE_LIMITED'],
      [500, 'UNREACHABLE'],
      [503, 'UNREACHABLE'],
    ];
    for (const [status, code] of table) assert.equal(statusErrorCode(status), code, String(status));
  });

  it('puts the code on the errors it throws', async () => {
    const code = (status: number) => ({ code: statusErrorCode(status) });
    await assert.rejects(executeAction('http.request', { url: `${baseUrl}/?status=404` }, environment()), code(404));
    await assert.rejects(executeAction('http.request', { url: `${baseUrl}/?status=503` }, environment()), code(503));
    await assert.rejects(executeAction('http.request', { url: `${baseUrl}/?status=429` }, environment()), { code: 'RATE_LIMITED' });
    await assert.rejects(executeAction('http.request', { url: 'http://127.0.0.1:9/' }, environment()), { code: 'UNREACHABLE' });
    await assert.rejects(executeAction('http.request', { url: `${baseUrl}/slow` }, { ...environment(), timeoutMs: 50 }), { code: 'TIMEOUT' });
    await assert.rejects(executeAction('http.request', { url: 'http://routine-db:5432/' }, environment()), { code: 'FORBIDDEN_HOST' });
    await assert.rejects(executeAction('http.request', { url: 'not a url' }, environment()), { code: 'INVALID_PARAMS' });
    await assert.rejects(executeAction('email.send', { subject: 'Hi' }, environment()), { code: 'INVALID_PARAMS' });
    await assert.rejects(executeAction('budget.record', {}, environment()), { code: 'NOT_AVAILABLE' });
  });

  it('reports the code in ActionFailed, INTERNAL for errors without one', () => {
    const ref = { actionId: randomUUID(), executionId: randomUUID(), actionType: 'http.request' };
    const failed = actionFailed(ref, new PermanentError('gone', { code: 'NOT_FOUND' }), 1, 'w@1');
    assert.deepEqual(failed.data.error, { code: 'NOT_FOUND', message: 'gone' });
    assert.deepEqual(contractErrors('action-failed.v1.schema.json', failed), []);
    assert.equal((actionFailed(ref, new TypeError('x'), 1, 'w@1').data.error as { code: string }).code, 'INTERNAL');
  });

  it('blocks hosts outside the allow-list (SSRF protection)', async () => {
    await assert.rejects(executeAction('http.request', { url: 'http://routine-db:5432/' }, environment()), /allow-list/);
  });

  it('re-checks every redirect target against the allow-list', async () => {
    const internal = encodeURIComponent('http://routine-db:5432/');
    await assert.rejects(executeAction('http.request', { url: `${baseUrl}/redirect?to=${internal}` }, environment()), /allow-list/);
    const output = await executeAction('http.request', { url: `${baseUrl}/redirect?to=%2F%3Fstatus%3D200` }, environment());
    assert.equal(output.status, 200);
  });

  it('keeps the actionId as idempotency key even if params set one', async () => {
    const env = environment();
    await executeAction('http.request', { url: baseUrl, headers: { 'Idempotency-Key': 'forged' } }, env);
    assert.equal(seenKeys.at(-1), env.actionId);
  });

  it('cuts off huge response bodies instead of buffering them', async () => {
    const output = await executeAction('http.request', { url: `${baseUrl}/huge` }, environment());
    assert.equal(typeof output.body, 'string');
    assert.equal((output.body as string).length, 2_001);
  });

  it('summary.generate renders sections', async () => {
    const output = await executeAction('summary.generate', { title: 'Week 37', sections: { Weather: 'sunny' }, lines: ['End'] }, environment());
    assert.equal(output.text, 'Week 37\n• Weather: sunny\n• End');
  });
});

describe('connections manifest (04 §7)', () => {
  it('validates, and the worker executes every capability it declares', async () => {
    const result = validateManifest(CONNECTIONS_MANIFEST);
    assert.equal(result.valid, true, result.valid ? '' : result.errors.join('; '));
    for (const capability of CONNECTIONS_MANIFEST.capabilities) {
      // empty params: every declared type is known – it fails on its params, never as NOT_AVAILABLE
      await assert.rejects(executeAction(capability.type, {}, environment()), (error: PermanentError) => error.code === 'INVALID_PARAMS', capability.type);
    }
  });
});
