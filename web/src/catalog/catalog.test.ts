import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Capability, CatalogDomain } from '../types.ts';
import { buildCatalog, runsInTest } from './catalog.ts';

const capability = (type: string, kind: Capability['kind'], extra: Partial<Capability> = {}): Capability => ({
  type, kind, label: type, sentence: type, description: '', params: [], output: [], sideEffects: kind !== 'value', since: 1, ...extra,
});
const domain = (name: string, order: number, capabilities: Capability[], enabled = true): CatalogDomain => ({
  contract: 1, domain: name, manifestVersion: 1, service: `${name}-service`, name, description: '', icon: 'bolt', tint: 'grey',
  order, optional: true, prefixes: [name], capabilities, enabled,
  collections: { lists: { label: 'Lists', list: `/api/v1/${name}`, idField: 'id', labelField: 'name' } },
});

describe('catalog', () => {
  const catalog = buildCatalog([
    domain('scripting', 90, [capability('scripting.set', 'value')]),
    domain('tasks', 10, [capability('tasks.create', 'action')]),
    domain('budget', 50, [capability('budget.record', 'action')], false),
  ]);

  it('looks up capabilities with their domain, in domain order', () => {
    assert.deepEqual(catalog.domains.map((entry) => entry.domain), ['tasks', 'budget', 'scripting']);
    assert.equal(catalog.capability('tasks.create')?.domain.domain, 'tasks');
    assert.equal(catalog.collection('tasks', 'lists')?.list, '/api/v1/tasks');
    assert.equal(catalog.capability('nope.x'), undefined);
  });

  it('offers only the capabilities of enabled domains', () => {
    assert.deepEqual(catalog.capabilities().map((entry) => entry.type), ['tasks.create', 'scripting.set']);
    assert.equal(catalog.enabled('budget'), false);
    assert.ok(catalog.capability('budget.record'), 'still known – a saved routine may use it');
  });

  it('lets values, side-effect-free steps and previews run in a test (like the server)', () => {
    assert.equal(runsInTest(capability('a.b', 'value')), true);
    assert.equal(runsInTest(capability('a.b', 'action')), false);
    assert.equal(runsInTest(capability('a.b', 'action', { preview: true })), true);
    assert.equal(runsInTest(capability('a.b', 'action', { sideEffects: false })), true);
    assert.equal(runsInTest(undefined), false);
  });
});
