import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DefinitionError, validateRoutine, type RoutineInput } from '../src/domain/definition.ts';
import { decideNext, inFlightStatus, type ActionProgress } from '../src/domain/progress.ts';
import { nextRun, validateSchedule } from '../src/domain/schedule.ts';
import { referencedActionKeys, resolveTemplates, TemplateError, type TemplateScope } from '../src/domain/templates.ts';

const weeklyReview: RoutineInput = {
  name: 'Weekly Review',
  trigger: { type: 'schedule', cron: '0 8 * * 1' },
  actions: [
    { key: 'weather', type: 'weather.get', step: 1, params: { city: 'Zürich' } },
    { key: 'task', type: 'task.create', step: 1, params: { title: 'Review' } },
    { key: 'summary', type: 'summary.generate', params: { title: 'KW', sections: { Wetter: '{{actions.weather.summary}}' } } },
    { key: 'notify', type: 'notification.send', params: { title: 'Fertig', body: '{{actions.summary.text}}' } },
  ],
};

describe('routine definition', () => {
  it('assigns sequential steps to actions without explicit step', () => {
    const definition = validateRoutine(weeklyReview);
    assert.deepEqual(
      definition.actions.map((action) => [action.key, action.step]),
      [['weather', 1], ['task', 1], ['summary', 2], ['notify', 3]],
    );
    assert.deepEqual(definition.trigger, { type: 'schedule', cron: '0 8 * * 1', timezone: 'Europe/Zurich' });
  });

  it('rejects unknown types, missing params, duplicate keys and forward references', () => {
    assert.throws(
      () =>
        validateRoutine({
          name: 'Broken',
          trigger: { type: 'manual' },
          actions: [
            { key: 'a', type: 'notification.send', params: { title: '{{actions.b.text}}' } },
            { key: 'b', type: 'summary.generate', params: {} },
            { key: 'b', type: 'teleport.now' },
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof DefinitionError);
        const issues = error.issues.join('\n');
        assert.match(issues, /duplicate action key "b"/);
        assert.match(issues, /unknown type "teleport.now"/);
        assert.match(issues, /missing required param "title"/);
        assert.match(issues, /can only reference actions of earlier steps/);
        return true;
      },
    );
  });

  it('rejects schedules that fire too often', () => {
    assert.match(validateSchedule('* * * * * *', 'Europe/Zurich')[0], /more often/);
    assert.deepEqual(validateSchedule('*/30 * * * * *', 'Europe/Zurich'), []);
    assert.match(validateSchedule('0 8 * * 1', 'Mars/Olympus')[0], /unknown timezone/);
  });

  it('computes the next run in the routine timezone', () => {
    // Monday 2026-09-14 08:00 Europe/Zurich (CEST, UTC+2)
    const next = nextRun('0 8 * * 1', 'Europe/Zurich', new Date('2026-09-11T12:00:00Z'));
    assert.equal(next.toISOString(), '2026-09-14T06:00:00.000Z');
  });
});

describe('templates', () => {
  const scope: TemplateScope = {
    routine: { id: 'r1', name: 'Weekly Review' },
    execution: { id: 'e1', trigger: 'manual', startedAt: '2026-09-11T08:00:00.000Z' },
    actions: { weather: { temperatureC: 21, summary: 'Sonnig, 21 °C', details: { wind: 5 } } },
    now: '2026-09-11T08:00:01.000Z',
  };

  it('interpolates text and keeps raw values for single placeholders', () => {
    assert.deepEqual(
      resolveTemplates({ body: 'Heute: {{actions.weather.summary}} ({{routine.name}})', temp: '{{actions.weather.temperatureC}}', raw: '{{actions.weather.details}}' }, scope),
      { body: 'Heute: Sonnig, 21 °C (Weekly Review)', temp: 21, raw: { wind: 5 } },
    );
  });

  it('fails on unresolved references', () => {
    assert.throws(() => resolveTemplates('{{actions.task.taskId}}', scope), TemplateError);
  });

  it('finds referenced action keys', () => {
    assert.deepEqual(referencedActionKeys({ a: ['{{actions.x.y}} {{actions.z}}'], b: '{{routine.name}}' }), ['x', 'z']);
  });
});

describe('execution progress', () => {
  const action = (key: string, step: number, status: ActionProgress['status'], dispatchedAt?: Date): ActionProgress => ({
    key,
    step,
    status,
    dispatchedAt,
  });

  it('dispatches the lowest pending step, all its actions in parallel', () => {
    assert.deepEqual(decideNext([action('a', 1, 'PENDING'), action('b', 1, 'PENDING'), action('c', 2, 'PENDING')]), {
      kind: 'dispatch',
      step: 1,
      keys: ['a', 'b'],
    });
  });

  it('waits while any action of the step is in flight', () => {
    assert.deepEqual(decideNext([action('a', 1, 'COMPLETED'), action('b', 1, 'RETRYING'), action('c', 2, 'PENDING')]), { kind: 'wait' });
  });

  it('continues with the next step and completes at the end', () => {
    assert.equal(decideNext([action('a', 1, 'COMPLETED'), action('c', 2, 'PENDING')]).kind, 'dispatch');
    assert.deepEqual(decideNext([action('a', 1, 'COMPLETED'), action('c', 2, 'COMPLETED')]), { kind: 'complete' });
  });

  it('fails as soon as one action failed', () => {
    assert.deepEqual(decideNext([action('a', 1, 'FAILED'), action('b', 1, 'DISPATCHED')]), { kind: 'fail', failedKey: 'a' });
  });

  it('reports WAITING for retries and unanswered actions', () => {
    const now = new Date('2026-09-11T08:00:30Z');
    assert.equal(inFlightStatus([action('a', 1, 'DISPATCHED', new Date('2026-09-11T08:00:25Z'))], now, 10_000), 'RUNNING');
    assert.equal(inFlightStatus([action('a', 1, 'DISPATCHED', new Date('2026-09-11T08:00:05Z'))], now, 10_000), 'WAITING');
    assert.equal(inFlightStatus([action('a', 1, 'RETRYING')], now, 10_000), 'WAITING');
  });
});
