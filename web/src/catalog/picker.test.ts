import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { setGeneratedForms } from '../action-forms.ts';
import { formsFromCatalog } from '../forms/generate.ts';
import type { CatalogDomain } from '../types.ts';
import { buildCatalog } from './catalog.ts';
import { pickerGroups } from './picker.ts';

// the live catalog, recorded (forms/catalog.fixture.json) – five domains
const DOMAINS = JSON.parse(readFileSync(new URL('../forms/catalog.fixture.json', import.meta.url), 'utf8')) as CatalogDomain[];
setGeneratedForms(formsFromCatalog(DOMAINS));
const catalog = buildCatalog(DOMAINS);
const outline = (groups: ReturnType<typeof pickerGroups>) => groups.map((group) => `${group.label}: ${group.items.map((item) => item.label).join(', ')}`);

describe('step picker', () => {
  it('groups by domain in domain order, scripting last', () => {
    const groups = pickerGroups(catalog);
    assert.deepEqual(groups.map((group) => group.label), ['Tasks', 'Notifications', 'Connections', 'Scripting']);
    assert.deepEqual(groups.at(-1)?.items.map((item) => item.type), ['routine.run', 'variable.set', 'condition.if', 'math.calculate']);
    assert.equal(groups.find((group) => group.id === 'you'), undefined, 'no human steps before M3');
  });

  it('suggests steps the previous step can fill – its own domain first, at most three', () => {
    const [suggested] = pickerGroups(catalog, { previousType: 'task.create' });
    assert.equal(suggested.label, 'Suggested');
    assert.deepEqual(suggested.items.map((item) => item.type), ['task.move', 'task.complete', 'notification.send']);
    assert.equal(suggested.items[0].hint, 'after "Create task"');
  });

  it('suggests nothing when nothing fits', () => {
    assert.equal(pickerGroups(catalog, { previousType: 'email.send' })[0].label, 'Tasks');
  });

  it('searches label, description and domain name, without suggestions', () => {
    assert.deepEqual(outline(pickerGroups(catalog, { query: 'mail', previousType: 'task.create' })), ['Connections: Send e-mail']);
    assert.deepEqual(outline(pickerGroups(catalog, { query: 'TICK' })), ['Tasks: Complete task, Get done tasks']); // "Ticks off a task.", "What you ticked off"
    assert.deepEqual(outline(pickerGroups(catalog, { query: 'notifications' })), ['Notifications: Send notification']);
    assert.deepEqual(pickerGroups(catalog, { query: 'nothing like this' }), []);
  });

  it('leaves out disabled domains', () => {
    const off = buildCatalog(DOMAINS.map((domain) => (domain.domain === 'notifications' ? { ...domain, enabled: false } : domain)));
    assert.ok(!pickerGroups(off).some((group) => group.id === 'notifications'));
  });
});
