import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { actionLabel, actionSentence, formOf, setGeneratedForms, type SentencePart } from '../action-forms.ts';
import type { Capability, CatalogDomain, ParamSpec } from '../types.ts';
import { dateMode } from './dates.ts';
import { formsFromCatalog } from './generate.ts';

const LIST: ParamSpec = { name: 'listId', label: 'List', type: 'ref', ref: { domain: 'tasks', collection: 'lists' } };
const capability = (type: string, sentence: string, params: ParamSpec[], extra: Partial<Capability> = {}): Capability => ({
  type, kind: 'action', label: type, sentence, description: `does ${type}`, params, output: [], sideEffects: true, since: 1, ...extra,
});

/** A slice of the tasks manifest (services/task-service) – the shapes the generator has to handle. */
const TASKS: CatalogDomain = {
  contract: 1, domain: 'tasks', manifestVersion: 1, service: 'task-service', name: 'Tasks', description: '', icon: 'checklist', tint: 'green',
  order: 10, optional: false, prefixes: ['task'], enabled: true,
  capabilities: [
    capability('task.plan', 'Plan {title}, due {dueDate}', [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'priority', label: 'Priority', type: 'choice', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }], default: 'low' },
      { name: 'dueDate', label: 'Due', type: 'date' },
      { name: 'limit', label: 'At most', type: 'integer', min: 1, advanced: true },
      LIST,
    ], { output: [{ name: 'taskId', label: 'Task ID', type: 'text' }] }),
    capability('task.count', 'Count open tasks in {listId}', [LIST, { name: 'overdueOnly', label: 'Only overdue', type: 'boolean', default: false }], { icon: 'number' }),
    capability('task.complete', 'Complete {taskId}', [{ name: 'taskId', label: 'Task', type: 'text', required: true }]),
  ],
};
const SCRIPTING: CatalogDomain = { ...TASKS, domain: 'scripting', prefixes: ['script'], capabilities: [capability('script.wait', 'Wait {seconds} seconds', [{ name: 'seconds', label: 'Seconds', type: 'number' }])] };

setGeneratedForms(formsFromCatalog([TASKS, SCRIPTING]));

describe('generated forms', () => {
  it('maps every param type to an editor field', () => {
    const fields = formOf('task.plan')?.fields ?? [];
    assert.deepEqual(fields.map((field) => [field.name, field.kind]), [['title', 'text'], ['priority', 'select'], ['dueDate', 'date'], ['limit', 'number'], ['listId', 'tasklist']]);
    assert.deepEqual(fields[1].optionLabels, { low: 'Low', high: 'High' });
    assert.equal(fields[0].required, true);
    assert.deepEqual([fields[3].min, fields[3].integer, fields[3].advanced], [1, true, true]);
    assert.equal(formOf('task.count')?.fields[1].kind, 'boolean');
  });

  it('takes look, defaults and outputs from the manifest, the look falling back to the domain', () => {
    const plan = formOf('task.plan');
    assert.deepEqual([plan?.label, plan?.blurb, plan?.glyph, plan?.tint], ['task.plan', 'does task.plan', 'checklist', 'green']);
    assert.deepEqual(plan?.defaults, { priority: 'low' });
    assert.deepEqual(plan?.outputs, { taskId: 'Task ID' });
    assert.equal(formOf('task.count')?.glyph, 'number');
    assert.equal(formOf('script.wait')?.scripting, true);
    assert.equal(plan?.scripting, undefined);
  });

  it('keeps the hand-made forms over the generated ones', () => {
    setGeneratedForms(formsFromCatalog([{ ...SCRIPTING, capabilities: [capability('condition.if', 'If {left}', [])] }, TASKS, SCRIPTING]));
    assert.equal(actionLabel('condition.if'), 'If');
    assert.equal(formOf('routine.run')?.fields[0].kind, 'routine');
    assert.equal(formOf('nope.nothing'), undefined);
    setGeneratedForms(formsFromCatalog([TASKS, SCRIPTING]));
  });
});

describe('generated sentences', () => {
  const words = (type: string, params: Record<string, unknown>) => actionSentence(type, params).map((part) => (typeof part === 'string' ? part : `[${part.token}]`)).join('');

  it('shows values in words', () => {
    assert.equal(words('task.plan', { title: 'Pay rent', dueDate: '+1d' }), 'Plan [Pay rent], due [tomorrow]');
    assert.equal(words('task.plan', { title: 'Pay rent', dueDate: '+0d' }), 'Plan [Pay rent], due [today]');
    assert.equal(words('task.plan', { title: 'Pay rent', dueDate: '2026-10-01' }), 'Plan [Pay rent], due [2026-10-01]');
    assert.equal(words('task.count', { listId: '0f8fad5b-d9cb-469f-a165-70867728950e' }), 'Count open tasks in [list]');
    assert.equal(words('task.complete', { taskId: '{{actions.task.taskId}}' }), 'Complete [{{actions.task.taskId}}]');
  });

  it('names an empty required param and leaves an empty optional one out with its words', () => {
    assert.equal(words('task.complete', {}), 'Complete [task]');
    assert.equal(words('task.plan', { title: 'Pay rent' }), 'Plan [Pay rent]');
    assert.equal(words('task.count', {}), 'Count open tasks');
    assert.equal(words('script.wait', { seconds: 5 }), 'Wait [5] seconds');
  });

  it('reads the date of a task created with the M2 form', () => {
    assert.equal(words('task.create', { title: 'Pay rent', dueDate: '+3d' }), 'Create task [Pay rent], due [in 3 days]');
  });

  it('falls back to the label for a type without a form', () => {
    assert.deepEqual(actionSentence('nope.nothing', {}), ['nope.nothing']);
  });
});

describe('v1 sentences', () => {
  // recorded from the hand-made forms before M2-09 – every v1 step still reads the same
  const fixture = JSON.parse(readFileSync(new URL('./v1-sentences.fixture.json', import.meta.url), 'utf8')) as Array<{ type: string; params: Record<string, unknown>; sentence: SentencePart[] }>;

  for (const [index, { type, params, sentence }] of fixture.entries()) {
    it(`${type} #${index} reads as before`, () => assert.deepEqual(actionSentence(type, params), sentence));
  }
});

describe('dateMode', () => {
  it('reads relative days, dates and references', () => {
    assert.deepEqual(dateMode(''), { mode: 'none', days: 2, date: '' });
    assert.equal(dateMode('+0d').mode, 'today');
    assert.equal(dateMode('+1d').mode, 'tomorrow');
    assert.deepEqual(dateMode('+5d'), { mode: 'days', days: 5, date: '' });
    assert.deepEqual(dateMode('2026-10-01'), { mode: 'date', days: 2, date: '2026-10-01' });
    assert.equal(dateMode('{{trigger.event.dueDate}}').mode, 'custom');
  });
});
