import type { Task } from '../types.ts';

/** The steps of one run that wait for you – a checklist (task-service.md §5). */
export interface Checklist {
  /** The run (step group). */
  executionId: string;
  routineName: string;
  items: Task[];
  done: number;
}

/**
 * Step tasks grouped per run, while the run still waits for one of them – the "Waiting for you"
 * section (M3-07, before Today exists). Done items stay in their group until the last is ticked;
 * cancelled ones are gone. A group whose items are all done stays while one of them `lingers`
 * (was just ticked), so the last tick is seen before the group goes.
 */
export function stepChecklists(tasks: Task[], lingering: ReadonlySet<string> = new Set()): Checklist[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.kind !== 'step' || task.status === 'CANCELLED') continue;
    const group = task.stepGroup ?? task.sourceExecutionId ?? task.id;
    groups.set(group, [...(groups.get(group) ?? []), task]);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.some((task) => task.status === 'OPEN' || lingering.has(task.id)))
    .map(([executionId, items]) => ({
      executionId,
      routineName: items[0].sourceRoutineName ?? 'A routine',
      items: [...items].sort((a, b) => (a.stepPosition ?? 0) - (b.stepPosition ?? 0) || a.createdAt.localeCompare(b.createdAt)),
      done: items.filter((task) => task.status === 'DONE').length,
    }))
    // the run that waits longest first
    .sort((a, b) => a.items[0].createdAt.localeCompare(b.items[0].createdAt));
}
