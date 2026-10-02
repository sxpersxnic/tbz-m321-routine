import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Task } from '../types.ts';
import { stepChecklists } from './checklists.ts';

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, listId: 'l', title: id, description: '', priority: 'normal', status: 'OPEN', dueDate: null, sourceExecutionId: null,
  kind: 'task', sourceRoutineId: null, sourceRoutineName: null, stepGroup: null, stepPosition: null, createdAt: '2026-10-01T07:00:00Z', completedAt: null, ...extra,
});
const step = (id: string, run: string, position: number, extra: Partial<Task> = {}) =>
  task(id, { kind: 'step', stepGroup: run, sourceExecutionId: run, stepPosition: position, sourceRoutineName: `Routine ${run}`, ...extra });

describe('checklists of steps that wait for you', () => {
  it('groups step tasks per run, in the order they were asked, with progress', () => {
    const lists = stepChecklists([step('b', 'r1', 1, { status: 'DONE' }), task('plain'), step('a', 'r1', 0), step('c', 'r1', 2, { status: 'CANCELLED' })]);
    assert.equal(lists.length, 1);
    assert.equal(lists[0].routineName, 'Routine r1');
    assert.deepEqual(lists[0].items.map((item) => item.id), ['a', 'b'], 'cancelled ones are gone');
    assert.equal(lists[0].done, 1);
  });

  it('drops a group once every item is done – unless one was just ticked', () => {
    const tasks = [step('a', 'r1', 0, { status: 'DONE' }), step('b', 'r2', 0)];
    assert.deepEqual(stepChecklists(tasks).map((list) => list.executionId), ['r2']);
    assert.deepEqual(stepChecklists(tasks, new Set(['a'])).map((list) => list.executionId), ['r1', 'r2']);
  });
});
