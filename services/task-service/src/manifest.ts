import type { DomainManifest, OutputField, ParamSpec } from '@routine/service-kit';

/**
 * The `tasks` domain (docs/v2/services/task-service.md §5) – M2: creating, completing, moving and
 * reading tasks, and the task events. Human steps (task.await …) and areas come with M3 and M5, as
 * new manifest versions (additions are compatible).
 */

const PRIORITY: ParamSpec = {
  name: 'priority',
  label: 'Priority',
  type: 'choice',
  options: [
    { value: 'low', label: 'Low' },
    { value: 'normal', label: 'Normal' },
    { value: 'high', label: 'High' },
  ],
  default: 'normal',
};
const LIST: ParamSpec = { name: 'listId', label: 'List', type: 'ref', ref: { domain: 'tasks', collection: 'lists' } };

/** A list of tasks as values return it – works with "Repeat for each". */
const TASK_ITEMS: OutputField[] = [
  { name: 'items', label: 'Tasks', type: 'list' },
  { name: 'count', label: 'Count', type: 'integer', example: 3 },
];

/** Fields of every task event (§4) – filterable, readable as {{trigger.event.<field>}}. */
const EVENT_FIELDS: OutputField[] = [
  { name: 'taskId', label: 'Task', type: 'text' },
  { name: 'title', label: 'Title', type: 'text', example: 'Write weekly review' },
  { name: 'listId', label: 'List', type: 'ref' },
  { name: 'listName', label: 'List name', type: 'text' },
  { name: 'areaId', label: 'Area', type: 'ref' },
  { name: 'priority', label: 'Priority', type: 'choice' },
  { name: 'dueDate', label: 'Due', type: 'date' },
  { name: 'kind', label: 'Kind', type: 'choice' },
  { name: 'sourceRoutineId', label: 'Created by routine', type: 'ref' },
];

export const TASKS_MANIFEST: DomainManifest = {
  contract: 1,
  domain: 'tasks',
  manifestVersion: 1,
  service: 'task-service',
  name: 'Tasks',
  description: 'To-dos on your lists – created, ticked and moved by routines too.',
  icon: 'checklist',
  tint: 'green',
  order: 10,
  optional: false,
  prefixes: ['task'],
  page: '/tasks',
  collections: {
    lists: { label: 'Lists', list: '/api/v1/task-lists', idField: 'id', labelField: 'name', iconField: 'icon', tintField: 'color' },
  },
  capabilities: [
    {
      type: 'task.create',
      kind: 'action',
      label: 'Create task',
      sentence: 'Create task {title}, due {dueDate}',
      description: 'Puts a task on your list.',
      params: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'description', label: 'Notes', type: 'longText' },
        PRIORITY,
        { name: 'dueInDays', label: 'Due in days', type: 'integer', min: 0, hint: '0 = today', advanced: true },
        { name: 'dueDate', label: 'Due', type: 'date' },
        LIST,
      ],
      output: [
        { name: 'taskId', label: 'Task ID', type: 'text' },
        { name: 'title', label: 'Task', type: 'text', example: 'Write weekly review' },
        { name: 'listId', label: 'List', type: 'ref' },
        { name: 'dueDate', label: 'Due date', type: 'date', example: '2026-10-01' },
        { name: 'priority', label: 'Priority', type: 'choice' },
      ],
      sideEffects: true,
      since: 1,
    },
    {
      type: 'task.complete',
      kind: 'action',
      label: 'Complete task',
      sentence: 'Complete {taskId}',
      description: 'Ticks off a task.',
      params: [{ name: 'taskId', label: 'Task', type: 'text', required: true, hint: 'Usually {{…}} from an earlier step' }],
      output: [
        { name: 'taskId', label: 'Task ID', type: 'text' },
        { name: 'completedAt', label: 'Done at', type: 'text' },
      ],
      sideEffects: true,
      since: 1,
    },
    {
      type: 'task.move',
      kind: 'action',
      label: 'Move task',
      sentence: 'Move {taskId} to {listId}',
      description: 'Moves a task to another list or day.',
      params: [
        { name: 'taskId', label: 'Task', type: 'text', required: true, hint: 'Usually {{…}} from an earlier step' },
        LIST,
        { name: 'dueDate', label: 'Due', type: 'date' },
      ],
      output: [{ name: 'taskId', label: 'Task ID', type: 'text' }],
      sideEffects: true,
      since: 1,
    },
    {
      type: 'task.openTasks',
      kind: 'value',
      label: 'Get open tasks',
      sentence: 'Get open tasks in {listId}, due by {dueBy}',
      description: 'The tasks still to do, soonest first.',
      params: [LIST, { name: 'dueBy', label: 'Due by', type: 'date' }, { name: 'limit', label: 'At most', type: 'integer', min: 1, max: 100, default: 20, advanced: true }],
      output: TASK_ITEMS,
      sideEffects: false,
      since: 1,
    },
    {
      type: 'task.doneTasks',
      kind: 'value',
      label: 'Get done tasks',
      sentence: 'Get tasks done since {since}',
      description: 'What you ticked off – for a review.',
      params: [{ name: 'since', label: 'Since', type: 'date', default: '+0d' }, { name: 'limit', label: 'At most', type: 'integer', min: 1, max: 100, default: 20, advanced: true }],
      output: TASK_ITEMS,
      sideEffects: false,
      since: 1,
    },
    {
      type: 'task.count',
      kind: 'value',
      label: 'Count tasks',
      sentence: 'Count open tasks in {listId}',
      description: 'How many tasks are open (or overdue).',
      params: [LIST, { name: 'overdueOnly', label: 'Only overdue', type: 'boolean', default: false }],
      output: [{ name: 'count', label: 'Count', type: 'integer', example: 4 }],
      sideEffects: false,
      since: 1,
    },
  ],
  triggers: [
    { type: 'task.created', label: 'A task is created', sentence: 'When a task {filter} is created', description: 'Runs when a task is added – by you or a routine.', fields: EVENT_FIELDS, since: 1 },
    {
      type: 'task.completed',
      label: 'A task is completed',
      sentence: 'When a task {filter} is completed',
      description: 'Runs when you tick a task.',
      fields: [...EVENT_FIELDS, { name: 'completedAt', label: 'Done at', type: 'text' }],
      since: 1,
    },
    { type: 'task.reopened', label: 'A task is reopened', sentence: 'When a task {filter} is reopened', description: 'Runs when a done task is opened again.', fields: EVENT_FIELDS, since: 1 },
    {
      type: 'task.moved',
      label: 'A task is moved',
      sentence: 'When a task {filter} is moved',
      description: 'Runs when a task changes its list or day.',
      fields: [...EVENT_FIELDS, { name: 'fromListId', label: 'From list', type: 'ref' }],
      since: 1,
    },
  ],
};
