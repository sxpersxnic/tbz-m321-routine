import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculate, conditionMet, ControlError, evaluateCondition, evaluateControlAction, setVariable } from '../src/domain/control.ts';
import { validateRoutine, type RoutineInput } from '../src/domain/definition.ts';

const result = (left: unknown, operator: string, right?: unknown) => evaluateCondition({ left, operator, right }).result;

describe('scripting actions', () => {
  it('compares numbers as numbers and everything else as text', () => {
    assert.equal(result('5', 'equals', 5), true);
    assert.equal(result('sunny', 'equals', 'Sunny'), false);
    assert.equal(result(21, 'greaterThan', '20'), true);
    assert.equal(result(3, 'lessThan', 2), false);
    assert.equal(result('Bern: sunny', 'contains', 'SUNNY'), true);
    assert.equal(result(['a', 'b'], 'contains', 'b'), true);
    assert.equal(result('x', 'notContains', 'y'), true);
    assert.equal(result('  ', 'isEmpty'), true);
    assert.equal(result([], 'isNotEmpty'), false);
    assert.throws(() => result('warm', 'greaterThan', 20), ControlError);
    assert.throws(() => result(1, 'between', 2), ControlError);
  });

  it('calculates and refuses what makes no sense', () => {
    assert.equal(calculate({ a: '21', operator: '*', b: 1.8 }).result, 37.800000000000004);
    assert.equal(calculate({ a: 7, operator: '%', b: 3 }).result, 1);
    assert.equal(calculate({ a: 2.345, operator: 'round', b: 1 }).result, 2.3);
    assert.equal(calculate({ a: 4, operator: 'max', b: 9 }).result, 9);
    assert.throws(() => calculate({ a: 1, operator: '/', b: 0 }), /division by zero/);
    assert.throws(() => calculate({ a: 'abc', operator: '+', b: 1 }), ControlError);
  });

  it('stores variables under valid names only', () => {
    assert.deepEqual(setVariable({ name: 'city', value: 'Bern' }), { name: 'city', value: 'Bern' });
    assert.throws(() => setVariable({ name: '1st', value: 1 }), ControlError);
    assert.throws(() => evaluateControlAction('weather.get', {}), ControlError);
  });

  it('runs a conditional step only for the expected, completed result', () => {
    assert.equal(conditionMet({ status: 'COMPLETED', output: { result: true } }, true), true);
    assert.equal(conditionMet({ status: 'COMPLETED', output: { result: true } }, false), false);
    // a skipped condition (inside another branch) skips everything that depends on it
    assert.equal(conditionMet({ status: 'SKIPPED', output: null }, false), false);
  });
});

describe('scripting in routine definitions', () => {
  const base: RoutineInput = {
    name: 'Warm day',
    trigger: { type: 'manual' },
    actions: [
      { key: 'weather', type: 'weather.get', params: { city: 'Bern' } },
      { key: 'warm', type: 'condition.if', params: { left: '{{actions.weather.temperatureC}}', operator: 'greaterThan', right: 20 } },
      { key: 'who', type: 'variable.set', params: { name: 'team', value: ['ada@example.com', 'bob@example.com'] } },
      { key: 'mail', type: 'email.send', runIf: { action: 'warm', is: true }, forEach: '{{vars.team}}', params: { to: '{{item}}', subject: 'Ice cream!' } },
    ],
  };

  it('accepts conditions, variables and loops that reference earlier steps', () => {
    const definition = validateRoutine(base);
    const mail = definition.actions.find((action) => action.key === 'mail');
    assert.deepEqual(mail?.runIf, { action: 'warm', is: true });
    assert.equal(mail?.forEach, '{{vars.team}}');
  });

  it('rejects conditions, loops and variables that cannot work', () => {
    const invalid = (actions: RoutineInput['actions']) => () => validateRoutine({ ...base, actions });
    assert.throws(invalid([{ key: 'n', type: 'notification.send', runIf: { action: 'nope', is: true }, params: { title: 'x' } }]), /unknown action "nope"/);
    assert.throws(invalid([base.actions[0], { key: 'n', type: 'notification.send', runIf: { action: 'weather', is: true }, params: { title: 'x' } }]), /is not a condition/);
    assert.throws(invalid([{ key: 'n', type: 'notification.send', params: { title: '{{item}}' } }]), /only available in a step that repeats/);
    assert.throws(invalid([{ key: 'n', type: 'notification.send', forEach: 'a list', params: { title: 'x' } }]), /exactly one/);
    assert.throws(invalid([{ key: 'n', type: 'notification.send', params: { title: '{{vars.ghost}}' } }]), /variable "ghost" is never set/);
    assert.throws(invalid([{ key: 'c', type: 'condition.if', params: { left: 1, operator: 'about', right: 2 } }]), /unknown comparison/);
    assert.throws(invalid([{ key: 'v', type: 'variable.set', params: { name: 'my var' } }]), /variable name/);
  });
});
