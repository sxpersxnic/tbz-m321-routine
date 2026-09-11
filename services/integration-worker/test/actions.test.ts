import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { PermanentError, TransientError } from '@routine/service-kit';
import { contractErrors } from '../../../contracts/validate.ts';
import { executeAction, type ActionEnvironment } from '../src/actions.ts';
import { actionCompleted } from '../src/messages.ts';

let server: Server;
let baseUrl: string;
const seenKeys: string[] = [];

before(async () => {
  server = createServer((request, response) => {
    seenKeys.push(String(request.headers['idempotency-key']));
    const status = Number(new URL(request.url ?? '/', 'http://x').searchParams.get('status') ?? 200);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ city: 'Bern', temperatureC: 20, condition: 'sonnig', ok: status < 400 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const environment = (): ActionEnvironment => ({ actionId: randomUUID(), externalApiUrl: baseUrl, allowedHosts: ['127.0.0.1'], timeoutMs: 2_000 });

describe('integration-worker actions', () => {
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

  it('blocks hosts outside the allow-list (SSRF protection)', async () => {
    await assert.rejects(executeAction('http.request', { url: 'http://routine-db:5432/' }, environment()), /allow-list/);
  });

  it('summary.generate renders sections', async () => {
    const output = await executeAction('summary.generate', { title: 'KW 37', sections: { Wetter: 'sonnig' }, lines: ['Ende'] }, environment());
    assert.equal(output.text, 'KW 37\n• Wetter: sonnig\n• Ende');
  });
});
