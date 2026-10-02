/** Version history and restore (06-engine §7), through the real routes against a real database. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

describe('versions', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  let app: FastifyInstance;
  before(async () => {
    h = await engineHarness();
    app = await h.api();
  });
  after(async () => {
    await app?.close();
    await h?.close();
  });

  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, payload: payload as never });
    return { status: response.statusCode, body: response.json() };
  };
  const input = (city: string) => ({
    name: 'Morning',
    description: '',
    trigger: { type: 'manual' },
    actions: [{ key: 'weather', type: 'weather.get', step: 1, params: { city } }],
  });

  it('records a version for every write that bumps the version, with what kind of write it was', async () => {
    const created = await call('POST', '/api/v1/routines', input('Bern'));
    assert.equal(created.status, 201);
    const id = created.body.id;
    await call('PUT', `/api/v1/routines/${id}`, input('Zurich'));
    await call('PATCH', `/api/v1/routines/${id}`, { color: 'teal' });
    await call('POST', `/api/v1/routines/${id}/activate`);

    const { status, body } = await call('GET', `/api/v1/routines/${id}/versions`);
    assert.equal(status, 200);
    assert.deepEqual(
      body.items.map((item: { version: number; origin: string }) => [item.version, item.origin]),
      [
        [4, 'activate'],
        [3, 'appearance'],
        [2, 'edit'],
        [1, 'create'],
      ],
    );
    assert.equal(body.items[3].definition.actions[0].params.city, 'Bern');
    assert.equal(body.items[0].definition.active, true);
    assert.equal(body.items[0].definition.color, 'teal');
    assert.equal(body.items[0].definition.webhookToken, undefined, 'no secrets in the history');
  });

  it('restores an old version as a new one, never rewriting history', async () => {
    const id = (await call('POST', '/api/v1/routines', input('Bern'))).body.id;
    await call('PUT', `/api/v1/routines/${id}`, input('Zurich'));

    const restored = await call('POST', `/api/v1/routines/${id}/versions/1/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.version, 3);
    assert.equal(restored.body.actions[0].params.city, 'Bern');

    const versions = (await call('GET', `/api/v1/routines/${id}/versions`)).body.items;
    assert.deepEqual(versions.map((item: { version: number }) => item.version), [3, 2, 1]);
    assert.equal(versions[0].origin, 'restore');
    const { active: _a, ...v1 } = versions[2].definition;
    const { active: _b, ...v3 } = versions[0].definition;
    assert.deepEqual(v3, v1, 'version 3 equals version 1');

    const one = await call('GET', `/api/v1/routines/${id}/versions/2`);
    assert.equal(one.body.definition.actions[0].params.city, 'Zurich');
    assert.equal((await call('GET', `/api/v1/routines/${id}/versions/9`)).status, 404);
    assert.equal((await call('POST', `/api/v1/routines/${id}/versions/9/restore`)).status, 404);
  });

  it('records the version a run used', async () => {
    const routine = await h.routine(input('Bern') as never);
    const id = await h.run(routine);
    assert.equal((await h.execution(id))?.routine_version, routine.version);
    const run = await call('GET', `/api/v1/executions/${id}`);
    assert.equal(run.body.routineVersion, routine.version);
  });
});
