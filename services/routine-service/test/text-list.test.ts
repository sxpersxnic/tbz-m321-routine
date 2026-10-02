/** Text and list steps (06-engine §9): pure evaluators, and in a run. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ControlError } from '../src/domain/control.ts';
import { evaluateControlAction } from '../src/domain/scripting.ts';
import { countItems, filterItems, formatText, getItem, MAX_TEXT, parseJson, replaceText, sortItems, splitText } from '../src/domain/text-list.ts';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

const tasks = [
  { title: 'Pay rent', priority: 'high', due: 3 },
  { title: 'buy milk', priority: 'low', due: 1 },
  { title: 'Call Sam', priority: 'high', due: 10 },
  { title: 'No date', priority: 'normal' },
];

describe('text steps', () => {
  it('formats (the engine resolved the {{…}} already)', () => {
    assert.deepEqual(formatText({ template: 'Hi Sam, sunny' }), { text: 'Hi Sam, sunny' });
    assert.deepEqual(formatText({ template: 42 }), { text: '42' });
    assert.throws(() => formatText({ template: 'x'.repeat(MAX_TEXT + 1) }), /longer than/);
  });

  it('replaces every time, or once – literally, not as a pattern', () => {
    assert.deepEqual(replaceText({ text: 'a.b.c', find: '.', replaceWith: '/' }), { text: 'a/b/c' });
    assert.deepEqual(replaceText({ text: 'a.b.c', find: '.', replaceWith: '/', all: false }), { text: 'a/b.c' });
    assert.deepEqual(replaceText({ text: 'cost: 5', find: '5', replaceWith: '$&$&' }), { text: 'cost: $&$&' });
    assert.throws(() => replaceText({ text: 'a', find: '' }), ControlError);
  });

  it('splits into trimmed pieces, empty ones left out', () => {
    assert.deepEqual(splitText({ text: 'milk, bread,, eggs ' }), { items: ['milk', 'bread', 'eggs'] });
    assert.deepEqual(splitText({ text: 'a;b', separator: ';' }), { items: ['a', 'b'] });
    assert.deepEqual(splitText({ text: '' }), { items: [] });
  });

  it('reads JSON, and says why it can not', () => {
    assert.deepEqual(parseJson({ text: '{"t": 21, "tags": ["a"]}' }), { value: { t: 21, tags: ['a'] } });
    assert.deepEqual(parseJson({ text: { already: true } }), { value: { already: true } });
    assert.throws(() => parseJson({ text: '{oops' }), /not JSON/);
  });
});

describe('list steps', () => {
  it('gets the first, the last or the n-th item (from 1)', () => {
    assert.deepEqual(getItem({ list: ['a', 'b', 'c'] }), { item: 'a' });
    assert.deepEqual(getItem({ list: ['a', 'b', 'c'], position: 'last' }), { item: 'c' });
    assert.deepEqual(getItem({ list: ['a', 'b', 'c'], position: '2' }), { item: 'b' });
    assert.throws(() => getItem({ list: ['a'], position: 3 }), /no item 3/);
    assert.throws(() => getItem({ list: [], position: 'first' }), /empty/);
    assert.throws(() => getItem({ list: ['a'], position: 0 }), ControlError);
    assert.throws(() => getItem({ list: 'abc' }), /must be a list/);
  });

  it('counts', () => {
    assert.deepEqual(countItems({ list: tasks }), { count: 4 });
  });

  it('filters like an If, on a field of each item or the item itself', () => {
    assert.deepEqual(filterItems({ list: tasks, field: 'priority', operator: 'equals', value: 'high' }).count, 2);
    assert.deepEqual(filterItems({ list: tasks, field: 'due', operator: 'lessThan', value: 5 }).items, [tasks[0], tasks[1]]);
    assert.deepEqual(filterItems({ list: ['apple', 'pear', 'pineapple'], operator: 'contains', value: 'apple' }).items, ['apple', 'pineapple']);
    assert.throws(() => filterItems({ list: tasks, field: 'title', operator: 'between' }), /unknown operator/);
  });

  it('sorts numbers by value, text case-insensitively, missing fields last', () => {
    assert.deepEqual((sortItems({ list: tasks, field: 'due' }).items as typeof tasks).map((task) => task.title), ['buy milk', 'Pay rent', 'Call Sam', 'No date']);
    assert.deepEqual((sortItems({ list: tasks, field: 'due', direction: 'desc' }).items as typeof tasks).map((task) => task.title), ['Call Sam', 'Pay rent', 'buy milk', 'No date']);
    assert.deepEqual((sortItems({ list: tasks, field: 'title' }).items as typeof tasks).map((task) => task.title), ['buy milk', 'Call Sam', 'No date', 'Pay rent']);
    assert.deepEqual(sortItems({ list: ['10', '9', '100'] }).items, ['9', '10', '100']);
  });

  it('are scripting steps the engine evaluates', () => {
    assert.deepEqual(evaluateControlAction('list.count', { list: [1, 2] }), { count: 2 });
  });
});

describe('text and list steps in a run', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  before(async () => {
    h = await engineHarness();
  });
  after(async () => {
    await h?.close();
  });

  it('split → filter → count → repeat for each → text, evaluated by the engine at once', async () => {
    const id = await h.run(await h.routine({
      actions: [
        { key: 'split', type: 'text.split', step: 1, params: { text: 'milk, bread, oat milk, eggs' } },
        { key: 'milks', type: 'list.filter', step: 2, params: { list: '{{actions.split.items}}', operator: 'contains', value: 'milk' } },
        { key: 'count', type: 'list.count', step: 3, params: { list: '{{actions.milks.items}}' } },
        { key: 'shout', type: 'text.replace', step: 3, forEach: '{{actions.milks.items}}', params: { text: '{{item}}', find: 'milk', replaceWith: 'MILK' } },
        { key: 'say', type: 'text.format', step: 4, params: { template: '{{actions.count.count}} kinds of milk' } },
      ],
    }));
    const actions = await h.actions(id);
    assert.equal((await h.execution(id))?.status, 'COMPLETED');
    assert.deepEqual(actions.milks.output?.items, ['milk', 'oat milk']);
    assert.deepEqual(actions['shout[1]'].output, { text: 'oat MILK' });
    assert.deepEqual(actions.say.output, { text: '2 kinds of milk' });
  });

  it('fails a step with a bad list as INVALID_PARAMS', async () => {
    const id = await h.run(await h.routine({ actions: [{ key: 'pick', type: 'list.get', step: 1, params: { list: [], position: 'first' } }] }));
    const pick = (await h.actions(id)).pick;
    assert.equal(pick.status, 'FAILED');
    assert.equal(pick.error_code, 'INVALID_PARAMS');
  });
});
