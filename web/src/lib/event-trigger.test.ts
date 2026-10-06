import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildCatalog } from '../catalog/catalog.ts';
import type { CatalogDomain } from '../types.ts';
import { eventFacts, eventReferences, eventTriggerSentence, eventWords, refPicker, startedBy, type NameOf } from './event-trigger.ts';

// the live catalog, recorded (forms/catalog.fixture.json)
const catalog = buildCatalog(JSON.parse(readFileSync(new URL('../forms/catalog.fixture.json', import.meta.url), 'utf8')) as CatalogDomain[]);
const WORK = '5c1f0e1e-0000-4000-8000-000000000001';
const BACKUP = '5c1f0e1e-0000-4000-8000-000000000002';
const names: NameOf = (picker, id) => (picker === 'tasklist' && id === WORK ? 'Work' : picker === 'routine' && id === BACKUP ? 'Backup' : undefined);

describe('event trigger sentence', () => {
  it('reads a filter on a picked list as "in <list>"', () => {
    assert.equal(eventTriggerSentence(catalog, { event: 'task.completed', filter: [{ field: 'listId', operator: 'equals', value: WORK }] }, names), 'When a task in Work is completed');
    assert.equal(eventTriggerSentence(catalog, { event: 'task.completed' }), 'When a task is completed', 'no filter, no words');
    assert.equal(eventTriggerSentence(catalog, { event: 'task.completed', filter: [{ field: 'listId', operator: 'equals', value: WORK }] }), 'When a task in a chosen list is completed', 'names not loaded yet');
  });

  it('joins several conditions and says each operator in words', () => {
    const filter = [
      { field: 'listId', operator: 'notEquals', value: WORK },
      { field: 'title', operator: 'contains', value: 'rent' },
      { field: 'dueDate', operator: 'isEmpty' },
    ];
    assert.equal(eventTriggerSentence(catalog, { event: 'task.created', filter }, names), 'When a task not in Work and with title containing "rent" and without due is created');
  });

  it('fills a sentence placeholder from the matching condition, or says "any"', () => {
    assert.equal(eventTriggerSentence(catalog, { event: 'execution.failed', filter: [{ field: 'routineId', operator: 'equals', value: BACKUP }] }, names), 'When "Backup" fails');
    assert.equal(eventTriggerSentence(catalog, { event: 'execution.failed', filter: [{ field: 'routineName', operator: 'equals', value: 'Nightly' }] }), 'When "Nightly" fails');
    assert.equal(eventTriggerSentence(catalog, { event: 'execution.failed' }), 'When any routine fails');
    assert.equal(
      eventTriggerSentence(catalog, { event: 'execution.failed', filter: [{ field: 'errorCode', operator: 'equals', value: 'TIMEOUT' }] }),
      'When any routine fails with why "TIMEOUT"',
      'the manifest sentence has no {filter}: the condition goes at its end',
    );
  });

  it('falls back to the event type for an event the catalog does not know (domain switched off)', () => {
    assert.equal(eventTriggerSentence(catalog, { event: 'budget.incomeRecorded' }), 'When budget income recorded');
    assert.equal(eventWords('home.shoppingItemAdded'), 'home shopping item added');
  });
});

describe('event trigger helpers', () => {
  it('offers the task lists and the routines as pickers for their ref fields', () => {
    assert.equal(refPicker(catalog.trigger('task.completed'), 'listId'), 'tasklist');
    assert.equal(refPicker(catalog.trigger('task.moved'), 'fromListId'), 'tasklist');
    assert.equal(refPicker(catalog.trigger('execution.failed'), 'routineId'), 'routine');
    assert.equal(refPicker(catalog.trigger('task.completed'), 'title'), null);
    assert.equal(refPicker(catalog.trigger('task.completed'), 'areaId'), null, 'no such collection yet');
  });

  it('makes a pill of every event field', () => {
    const references = eventReferences(catalog.trigger('task.completed'));
    assert.equal(references['{{trigger.event.title}}'], 'Title');
    assert.equal(references['{{trigger.event.listName}}'], 'List name');
    assert.deepEqual(eventReferences(undefined), {});
  });

  it('says what started a run, and which facts of the event matter', () => {
    const event = { event: 'task.completed', data: { taskId: 'x', title: 'Write report', listId: WORK, listName: 'Work', priority: 'high', dueDate: null } };
    assert.equal(startedBy(event), 'task completed: Write report');
    assert.equal(startedBy({ event: 'execution.failed', data: { routineName: 'Backup' } }), 'execution failed: Backup');
    assert.equal(startedBy({ event: 'task.created', data: {} }), 'task created');
    assert.deepEqual(eventFacts(catalog, event), [{ label: 'Title', value: 'Write report' }, { label: 'List name', value: 'Work' }, { label: 'Priority', value: 'high' }]);
  });
});
