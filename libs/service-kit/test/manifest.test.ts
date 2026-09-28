import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { contractErrors } from '../../../contracts/validate.ts';
import { canonicalJson, manifestDigest, manifestSchema, validateManifest, type DomainManifest } from '../src/manifest.ts';

const manifest = (): DomainManifest => ({
  contract: 1,
  domain: 'tasks',
  manifestVersion: 1,
  service: 'task-service',
  name: 'Tasks',
  description: 'To-dos and lists.',
  icon: 'checklist',
  tint: 'sky',
  order: 10,
  optional: false,
  prefixes: ['task'],
  page: '/tasks',
  collections: { lists: { label: 'Lists', list: '/api/v1/lists', idField: 'id', labelField: 'name' } },
  capabilities: [
    {
      type: 'task.create',
      kind: 'action',
      label: 'Create task',
      sentence: 'Create {title}',
      description: 'Adds a task to a list.',
      params: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'listId', label: 'List', type: 'ref', ref: { domain: 'tasks', collection: 'lists' } },
        { name: 'priority', label: 'Priority', type: 'choice', options: [{ value: 'high', label: 'High' }], advanced: true },
      ],
      output: [{ name: 'taskId', label: 'Task', type: 'text' }],
      sideEffects: true,
      since: 1,
    },
    {
      type: 'task.openCount',
      kind: 'value',
      label: 'Open tasks',
      sentence: 'Count open tasks',
      description: 'How many tasks are still open.',
      params: [],
      output: [{ name: 'count', label: 'Count', type: 'integer', example: 3 }],
      sideEffects: false,
      since: 1,
    },
    {
      type: 'task.await',
      kind: 'human',
      label: 'Do yourself',
      sentence: 'Do {title} yourself',
      description: 'Waits until you tick the task.',
      params: [{ name: 'title', label: 'Title', type: 'text', required: true }],
      output: [{ name: 'completedAt', label: 'Done at', type: 'text' }],
      sideEffects: true,
      human: { awaits: 'task', defaultTimeout: 'P1D' },
      since: 1,
    },
  ],
  triggers: [
    {
      type: 'task.completed',
      label: 'A task is completed',
      sentence: 'When a task {filter} is completed',
      description: 'Runs when you tick a task.',
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      since: 1,
    },
  ],
  todayCards: ['item'],
});

const errorsOf = (value: unknown) => {
  const result = validateManifest(value);
  return result.valid ? [] : result.errors;
};

describe('validateManifest', () => {
  it('accepts a valid manifest and returns it typed', () => {
    const result = validateManifest(manifest());
    assert.equal(result.valid, true);
    assert.deepEqual(errorsOf(manifest()), []);
  });

  it('accepts every v1 action type under the widened pattern', () => {
    const value = manifest();
    value.prefixes = ['task', 'http', 'routine'];
    for (const type of ['http.request', 'routine.run']) {
      value.capabilities.push({ ...value.capabilities[0], type });
    }
    assert.deepEqual(errorsOf(value), []);
  });

  it('rejects a capability type with three segments or upper case', () => {
    for (const type of ['task.list.create', 'Task.create', 'task.Create']) {
      const value = manifest();
      value.capabilities[0].type = type;
      assert.ok(errorsOf(value).some((error) => error.includes('/capabilities/0/type')), type);
    }
  });

  it('rejects types outside the domain prefixes, and duplicates', () => {
    const foreign = manifest();
    foreign.triggers = [{ ...manifest().triggers?.[0], type: 'budget.incomeRecorded' } as NonNullable<DomainManifest['triggers']>[number]];
    assert.match(errorsOf(foreign).join(), /\/triggers\/0\/type budget.incomeRecorded does not start with one of the prefixes task/);

    const duplicate = manifest();
    duplicate.capabilities[1].type = 'task.create';
    assert.match(errorsOf(duplicate).join(), /\/capabilities\/1\/type task.create is declared twice/);
  });

  it('rejects values with side effects and actions without', () => {
    const value = manifest();
    value.capabilities[1].sideEffects = true;
    assert.ok(errorsOf(value).some((error) => error.startsWith('/capabilities/1/sideEffects')));

    const action = manifest();
    action.capabilities[0].sideEffects = false;
    assert.ok(errorsOf(action).some((error) => error.startsWith('/capabilities/0/sideEffects')));
  });

  it('requires `human` on human steps', () => {
    const value = manifest();
    delete value.capabilities[2].human;
    assert.ok(errorsOf(value).some((error) => error.includes("must have required property 'human'")));
  });

  it('requires options on choice params and a collection on ref params', () => {
    const value = manifest();
    delete value.capabilities[0].params[1].ref;
    delete value.capabilities[0].params[2].options;
    assert.deepEqual(errorsOf(value), [
      '/capabilities/0/params/1 a ref param needs ref',
      '/capabilities/0/params/2 a choice param needs options',
    ]);
  });

  it('rejects missing fields, a wrong contract version and more than three setup questions', () => {
    const { capabilities: _, ...withoutCapabilities } = manifest();
    assert.ok(errorsOf(withoutCapabilities).some((error) => error.includes("'capabilities'")));
    assert.ok(errorsOf({ ...manifest(), contract: 2 }).some((error) => error.startsWith('/contract')));

    const question = { name: 'list', label: 'List', type: 'text' as const };
    const template = {
      id: 'task.weekly',
      name: 'Weekly',
      description: 'A weekly review.',
      icon: 'calendar',
      tint: 'sky' as const,
      requires: ['tasks'],
      setup: [question, question, question, question],
      routine: {},
    };
    assert.ok(errorsOf({ ...manifest(), templates: [template] }).some((error) => error.startsWith('/templates/0/setup')));
  });
});

describe('manifest schema', () => {
  it('ships with the kit identical to contracts/schemas/domain-manifest.v1.schema.json', () => {
    const contract = JSON.parse(readFileSync(join(import.meta.dirname, '../../../contracts/schemas/domain-manifest.v1.schema.json'), 'utf8'));
    assert.deepEqual(manifestSchema, contract);
  });

  it('validates the fixture through the contract-test helper', () => {
    assert.deepEqual(contractErrors('domain-manifest.v1.schema.json', manifest()), []);
  });
});

describe('manifestDigest', () => {
  /** The same object with its keys in reverse order, at every level. */
  const reversed = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reversed);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
    return value;
  };

  it('is a SHA-256 hex string, stable under key reordering', () => {
    const digest = manifestDigest(manifest());
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.notEqual(JSON.stringify(reversed(manifest())), JSON.stringify(manifest()));
    assert.equal(manifestDigest(reversed(manifest()) as DomainManifest), digest);
  });

  it('changes with the content, including array order', () => {
    const digest = manifestDigest(manifest());
    assert.notEqual(manifestDigest({ ...manifest(), name: 'To-dos' }), digest);
    const swapped = manifest();
    swapped.capabilities.reverse();
    assert.notEqual(manifestDigest(swapped), digest);
  });

  it('sorts keys recursively in canonical JSON', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  });
});
