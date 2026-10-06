/** The catalog (04 §4.5) and validation against it (04 §2.1, 06 §2.1). */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { DomainManifest } from '@routine/service-kit';
import type { FastifyInstance } from 'fastify';
import { SCRIPTING_MANIFEST } from '../src/domain/builtin-manifests.ts';
import { BUILTIN_CATALOG, Catalog } from '../src/domain/catalog.ts';
import { CONDITION_OPERATORS, MATH_OPERATORS } from '../src/domain/control.ts';
import { DefinitionError, validateRoutine, type RoutineInput } from '../src/domain/definition.ts';
import { applyRegistration } from '../src/registry.ts';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

/** A tasks manifest owning `task` – what task-service registers from M2-04 on (abridged). */
const tasks: DomainManifest = {
  contract: 1, domain: 'tasks', manifestVersion: 1, service: 'task-service', name: 'Tasks', description: 'To-dos.', icon: 'checklist',
  tint: 'green', order: 10, optional: false, prefixes: ['task'],
  collections: { lists: { label: 'Lists', list: '/api/v1/task-lists', idField: 'id', labelField: 'name' } },
  capabilities: [{
    type: 'task.create', kind: 'action', label: 'Create task', sentence: 'Create {title}', description: 'Adds a task.',
    params: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'priority', label: 'Priority', type: 'choice', options: [{ value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }] },
      { name: 'dueInDays', label: 'Due in days', type: 'integer', min: 0 },
      { name: 'dueDate', label: 'Due', type: 'date' },
      { name: 'listId', label: 'List', type: 'ref', ref: { domain: 'tasks', collection: 'lists' } },
    ],
    output: [{ name: 'taskId', label: 'Task', type: 'text' }], sideEffects: true, since: 1,
  }],
};

const routine = (params: Record<string, unknown>, type = 'task.create'): RoutineInput => ({ name: 'R', trigger: { type: 'manual' }, actions: [{ key: 'a', type, params }] });
const issues = (input: RoutineInput, catalog: Catalog) => {
  try {
    validateRoutine(input, catalog);
    return [];
  } catch (error) {
    if (error instanceof DefinitionError) return error.issues;
    throw error;
  }
};

describe('catalog', () => {
  it('offers the engine exactly the operators it evaluates', () => {
    const options = (type: string) => SCRIPTING_MANIFEST.capabilities.find((capability) => capability.type === type)?.params.find((param) => param.name === 'operator')?.options?.map((option) => option.value);
    assert.deepEqual(options('condition.if'), [...CONDITION_OPERATORS]);
    assert.deepEqual(options('math.calculate'), [...MATH_OPERATORS]);
  });

  it('keeps v1 steps valid until their domain registers, then uses its manifest', () => {
    assert.equal(BUILTIN_CATALOG.capability('task.create')?.domain, 'tasks');
    assert.equal(BUILTIN_CATALOG.capability('variable.set')?.runsIn, 'engine');
    assert.equal(BUILTIN_CATALOG.capability('weather.get')?.runsIn, 'worker');
    const withTasks = new Catalog([...[SCRIPTING_MANIFEST], tasks]);
    assert.equal(withTasks.capability('task.create')?.label, 'Create task');
    assert.equal(withTasks.capability('weather.get')?.domain, 'connections', 'still the fallback');
  });

  it('checks literal params against their spec, and leaves templates for run time', () => {
    const catalog = new Catalog([tasks]);
    assert.deepEqual(issues(routine({ title: 'x', priority: 'urgent', dueInDays: -1, dueDate: 'soon', listId: 'groceries' }), catalog), [
      'action "a": unknown priority "urgent"',
      'action "a": "dueInDays" must be at least 0',
      'action "a": "dueDate" must be a date (YYYY-MM-DD or +Nd)',
      'action "a": "listId" must be a lists id',
    ]);
    // (only the template check speaks: the variable isn't set anywhere)
    assert.deepEqual(issues(routine({ title: 'x', priority: '{{vars.p}}', dueInDays: '2', dueDate: '+1d', listId: '' }), catalog), ['action "a": variable "p" is never set']);
    assert.deepEqual(issues(routine({}), catalog), ['action "a": missing required param "title"']);
    assert.deepEqual(issues(routine({ title: 'x', dueInDays: 1.5 }), catalog), ['action "a": "dueInDays" must be a whole number']);
    assert.deepEqual(issues(routine({ left: 1, operator: 'about', right: 2 }, 'condition.if'), BUILTIN_CATALOG), ['action "a": unknown comparison "about"']);
  });

  it('has an ETag that changes with any manifest version', () => {
    assert.equal(new Catalog([tasks]).digest, new Catalog([tasks]).digest);
    assert.notEqual(new Catalog([tasks]).digest, new Catalog([{ ...tasks, manifestVersion: 2 }]).digest);
    assert.deepEqual(BUILTIN_CATALOG.actionTypes().find((type) => type.type === 'task.create'), {
      type: 'task.create', description: 'Create a task in the task system (optional listId, default list otherwise)', runsIn: 'worker', requiredParams: ['title'], example: { title: '' },
    });
  });
});

describe('catalog API', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  let app: FastifyInstance;
  before(async () => {
    h = await engineHarness();
    await applyRegistration(h.pool, { manifest: tasks, instance: 'task-service@test' });
    app = await h.api();
  });
  after(async () => {
    await app?.close();
    await h?.close();
  });

  it('serves the registered manifests with an ETag, 304 when unchanged', async () => {
    const first = await app.inject({ url: '/api/v1/catalog' });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().domains.map((domain: { domain: string; enabled: boolean }) => [domain.domain, domain.enabled]), [
      ['tasks', true],
      ['routines', true],
      ['scripting', true],
    ]);
    const again = await app.inject({ url: '/api/v1/catalog', headers: { 'if-none-match': first.headers.etag as string } });
    assert.equal(again.statusCode, 304);
  });

  it('validates without saving, against the registry', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/routines/validate', payload: routine({ title: 'x', priority: 'urgent' }) });
    assert.deepEqual(response.json(), { issues: ['action "a": unknown priority "urgent"'], warnings: [] });
    const ok = await app.inject({ method: 'POST', url: '/api/v1/routines/validate', payload: routine({ title: 'x', priority: 'high' }) });
    assert.deepEqual(ok.json(), { issues: [], warnings: [] });
    const saved = await app.inject({ method: 'POST', url: '/api/v1/routines', payload: routine({ title: 'x', priority: 'urgent' }) });
    assert.equal(saved.statusCode, 422, 'saving uses the same rules');
  });

  it('keeps /action-types in the v1 shape', async () => {
    const items = (await app.inject({ url: '/api/v1/action-types' })).json().items;
    assert.ok(items.some((item: { type: string; requiredParams: string[] }) => item.type === 'task.create' && item.requiredParams.includes('title')));
  });
});
