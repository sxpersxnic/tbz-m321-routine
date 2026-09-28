import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VersionDefinition } from '../types.ts';
import { describeChanges, restoredFrom } from './diff.ts';

const base = (): VersionDefinition => ({
  name: 'Morning',
  description: 'Weather and a plan',
  trigger: { type: 'schedule', cron: '0 8 * * 1', timezone: 'Europe/Zurich' },
  icon: null,
  color: null,
  active: true,
  actions: [
    { key: 'weather', type: 'weather.get', step: 1, params: { city: 'Bern' } },
    { key: 'task', type: 'task.create', step: 2, params: { title: 'Plan the day', priority: 'normal' } },
    { key: 'notify', type: 'notification.send', step: 3, params: { title: '{{actions.weather.summary}}' } },
  ],
});

const change = (edit: (definition: VersionDefinition) => void) => {
  const next = base();
  edit(next);
  return describeChanges(base(), next, 'edit');
};

describe('plain-language version diff (07-web §8)', () => {
  it('says "Created" for the first version and nothing for where history starts', () => {
    assert.deepEqual(describeChanges(null, base(), 'create'), ['Created']);
    assert.deepEqual(describeChanges(null, base(), 'backfill'), []);
  });

  it('names name, description and schedule changes first', () => {
    assert.deepEqual(
      change((next) => {
        next.name = 'Morning plan';
        next.description = '';
        next.trigger = { type: 'schedule', cron: '30 7 * * 1-5', timezone: 'Europe/London' };
      }),
      [
        'Renamed from "Morning" to "Morning plan"',
        'Removed the description',
        'Schedule changed from every Monday at 08:00 to every weekday at 07:30',
        'Time zone changed from Europe/Zurich to Europe/London',
      ],
    );
    assert.deepEqual(change((next) => {
      next.trigger = { type: 'webhook' };
    }), ['Start changed from every Monday at 08:00 to webhook']);
  });

  it('adds, removes and replaces steps by key', () => {
    assert.deepEqual(
      change((next) => {
        next.actions = next.actions.filter((action) => action.key !== 'task');
        next.actions.push({ key: 'mail', type: 'email.send', step: 4, params: { to: 'ada@example.com', subject: 'Morning' } });
      }),
      ['Removed step: Create task Plan the day', 'Added step: Send e-mail Morning to ada@example.com'],
    );
    assert.deepEqual(
      change((next) => {
      next.actions[1] = { key: 'task', type: 'notification.send', step: 2, params: { title: 'x' } };
    }),
      ['Replaced Task with Notification'],
    );
  });

  it('says a step moved after another, not that every step number shifted', () => {
    assert.deepEqual(
      change((next) => {
        const [weather, task, notify] = next.actions;
        next.actions = [weather, { ...notify, step: 2 }, { ...task, step: 3 }];
      }),
      ['Moved Task after Notification'],
    );
    assert.deepEqual(change((next) => {
      next.actions[1].step = 1;
    }), ['Weather now runs together with Task'], 'said once for the pair');
  });

  it('names changed params by their label and shows values in words', () => {
    assert.deepEqual(
      change((next) => {
        next.actions[0].params.city = 'Zurich';
        next.actions[1].params.priority = 'high';
        next.actions[2].params.title = '{{actions.weather.condition}}';
      }),
      ['Changed city from Bern to Zurich', 'Changed priority from Normal to High', 'Changed title from Forecast to Conditions'],
    );
    assert.deepEqual(change((next) => {
      next.actions[1].params.dueInDays = 2;
    }), ['Changed due in days from nothing to 2']);
  });

  it('says which of two steps of a kind changed', () => {
    const two = base();
    two.actions.splice(1, 0, { key: 'weather2', type: 'weather.get', step: 1, params: { city: 'Basel' } });
    const next = structuredClone(two);
    next.actions[1].params.city = 'Lugano';
    assert.deepEqual(describeChanges(two, next, 'edit'), ['Changed city in Get weather for Lugano from Basel to Lugano']);
  });

  it('notes conditions and loops', () => {
    assert.deepEqual(
      change((next) => {
        next.actions[2].runIf = { action: 'weather', is: true };
        next.actions[1].forEach = '{{actions.weather.summary}}';
      }),
      ['Task now repeats for each Forecast', 'Notification now depends on a condition'],
    );
  });

  it('describes appearance, activation and the webhook address', () => {
    assert.deepEqual(change((next) => Object.assign(next, { color: 'teal', icon: 'sun' })), ['Colour changed to Teal', 'Symbol changed to Sun']);
    const off = { ...base(), active: false };
    assert.deepEqual(describeChanges(base(), off, 'deactivate'), ['Turned off']);
    assert.deepEqual(describeChanges(off, base(), 'activate'), ['Turned on']);
    assert.deepEqual(describeChanges(base(), base(), 'webhook'), ['Webhook address changed']);
    assert.deepEqual(describeChanges(base(), base(), 'edit'), ['Saved without changes']);
  });

  it('finds the version a restore brought back', () => {
    const v1 = base();
    const v2 = { ...base(), name: 'Changed' };
    const v3 = { ...base(), active: false };
    const versions = [
      { version: 3, definition: v3 },
      { version: 2, definition: v2 },
      { version: 1, definition: v1 },
    ];
    assert.equal(restoredFrom(versions, 0), 1, 'active does not count');
    assert.equal(restoredFrom(versions, 1), undefined);
  });
});
