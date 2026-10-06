/** "Ask when run?" (06-engine §2, §3): questions, answers, and {{input.<name>}} in a run. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type DefinitionError, validateRoutine } from '../src/domain/definition.ts';
import { type InputError, inputSpecIssues, resolveInputs, type RoutineInputSpec } from '../src/domain/inputs.ts';
import { engineHarness, needsDatabase, type EngineHarness } from './support/engine-harness.ts';

const CITY: RoutineInputSpec = { name: 'city', label: 'Which city?', type: 'text', default: 'Bern' };
const DAYS: RoutineInputSpec = { name: 'days', label: 'How many days?', type: 'number', required: true };
const MOOD: RoutineInputSpec = { name: 'mood', label: 'Mood', type: 'choice', options: [{ value: 'good', label: 'Good' }, { value: 'bad', label: 'Bad' }] };

describe('run inputs', () => {
  it('answers every question – defaults filled in, numbers as numbers', () => {
    assert.deepEqual(resolveInputs([CITY, DAYS], { days: '3' }), { city: 'Bern', days: 3 });
    assert.deepEqual(resolveInputs([CITY, DAYS, MOOD], { city: 'Basel', days: 1, mood: 'good' }), { city: 'Basel', days: 1, mood: 'good' });
  });

  it('refuses missing, malformed and unasked answers', () => {
    assert.throws(() => resolveInputs([CITY, DAYS], {}), (error: InputError) => error.issues.includes('"How many days?" needs an answer'));
    assert.throws(() => resolveInputs([DAYS], { days: 'many' }), /must be a number/);
    assert.throws(() => resolveInputs([MOOD], { mood: 'meh' }), /not one of the choices/);
    assert.throws(() => resolveInputs([CITY], { town: 'Bern' }), /"town" is not a question/);
    assert.throws(() => resolveInputs([{ name: 'on', label: 'On', type: 'date' }], { on: 'tomorrow' }), /must be a date/);
  });

  it('checks the questions themselves', () => {
    assert.deepEqual(inputSpecIssues([CITY, DAYS, MOOD]), []);
    assert.equal(inputSpecIssues([{ ...CITY, name: 'City' }]).length, 1);
    assert.equal(inputSpecIssues([CITY, CITY]).length, 1);
    assert.equal(inputSpecIssues([{ ...MOOD, options: [] }]).length, 1);
    assert.equal(inputSpecIssues([{ ...DAYS, default: 'x' }]).length, 1);
    assert.equal(inputSpecIssues(Array.from({ length: 11 }, (_, i) => ({ ...CITY, name: `q${i}` }))).length, 1);
  });

  it('asks only when run by hand, and {{input.<name>}} must be a question', () => {
    const input = (trigger: Record<string, unknown>, value = '{{input.city}}') => ({
      name: 'R', trigger: trigger as never, inputs: [CITY], actions: [{ key: 'a', type: 'variable.set', params: { name: 'x', value } }],
    });
    assert.deepEqual(validateRoutine(input({ type: 'manual' })).inputs, [CITY]);
    assert.throws(() => validateRoutine(input({ type: 'webhook' })), (error: DefinitionError) => error.issues.includes('questions are only asked when a routine is run by hand'));
    assert.throws(() => validateRoutine(input({ type: 'manual' }, '{{input.town}}')), /"town" is not a question/);
    // without questions, {{input}} stays what a calling routine passes (v1)
    assert.doesNotThrow(() => validateRoutine({ ...input({ type: 'manual' }, '{{input.anything}}'), inputs: undefined }));
  });
});

describe('run inputs in a run', { skip: needsDatabase }, () => {
  let h: EngineHarness;
  before(async () => {
    h = await engineHarness();
  });
  after(async () => {
    await h?.close();
  });

  it('starts with the answers – stored on the run, readable as {{input.<name>}} – and refuses bad ones (422)', async () => {
    const app = await h.api();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/routines',
      payload: {
        name: 'Trip', trigger: { type: 'manual' }, inputs: [CITY, DAYS],
        actions: [{ key: 'say', type: 'variable.set', params: { name: 'result', value: '{{input.city}} for {{input.days}} days' } }, { key: 'days', type: 'math.calculate', params: { a: '{{input.days}}', operator: '*', b: 2 } }],
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().inputs, [CITY, DAYS]);
    const id = created.json().id;
    await app.inject({ method: 'POST', url: `/api/v1/routines/${id}/activate` });

    const bad = await app.inject({ method: 'POST', url: `/api/v1/routines/${id}/executions`, payload: { inputs: {} } });
    assert.equal(bad.statusCode, 422);
    assert.ok(bad.json().errors.includes('"How many days?" needs an answer'));

    const run = await app.inject({ method: 'POST', url: `/api/v1/routines/${id}/executions`, payload: { inputs: { days: '4' } } });
    assert.equal(run.statusCode, 202, run.body);
    const executionId = run.json().id;
    assert.deepEqual(run.json().inputs, { city: 'Bern', days: 4 });
    await h.engine.start(executionId);
    const actions = await h.actions(executionId);
    assert.equal(actions.say.output?.value, 'Bern for 4 days');
    assert.equal(actions.days.output?.result, 8);
    await app.close();
  });
});
