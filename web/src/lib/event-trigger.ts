/**
 * Event triggers in words (docs/v2/07-web.md §5.6): the trigger sentence on tiles, the hero and the
 * editor, the `{{trigger.event.<field>}}` pills, and what a run says about the event that started it.
 * Pure – the catalog and the names of picked lists/routines come in as arguments.
 */
import type { Catalog, CatalogTrigger } from '../catalog/catalog.ts';
import type { Condition, OutputField } from '../types.ts';

/** The operators of `condition.if`, in the words a filter row shows. */
export const FILTER_OPERATORS: Array<{ value: string; label: string; unary?: boolean }> = [
  { value: 'equals', label: 'is' },
  { value: 'notEquals', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'greaterThan', label: 'is greater than' },
  { value: 'lessThan', label: 'is less than' },
  { value: 'isEmpty', label: 'is empty', unary: true },
  { value: 'isNotEmpty', label: 'is not empty', unary: true },
];

/** The server's limit (06 §2.1). */
export const MAX_FILTER_CONDITIONS = 5;

/** A picker the editor has for a `ref` field: task lists or routines. */
export type RefPicker = 'tasklist' | 'routine';

/**
 * Which picker a filter field gets: a `ref` field named after a collection of its domain
 * (`listId`, `fromListId` → the task lists; `routineId` → the routines). Null = a plain value.
 *
 * @example refPicker(catalog.trigger('task.completed'), 'listId') // → 'tasklist'
 */
export function refPicker(trigger: CatalogTrigger | undefined, field: string): RefPicker | null {
  const spec = trigger?.fields.find((candidate) => candidate.name === field);
  if (!trigger || spec?.type !== 'ref') return null;
  const thing = /([A-Z]?[a-z0-9]+)Id$/.exec(field)?.[1]?.toLowerCase();
  if (!thing || !trigger.domain.collections?.[`${thing}s`]) return null;
  if (trigger.domain.domain === 'tasks' && thing === 'list') return 'tasklist';
  if (thing === 'routine') return 'routine';
  return null;
}

/** Names of picked things by id – what the sentence says instead of an id. */
export type NameOf = (picker: RefPicker, id: string) => string | undefined;

const quoted = (value: unknown) => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value));

/** One condition in words, e.g. `in Work`, `with title containing "rent"`, `without due`. */
function conditionWords(trigger: CatalogTrigger, condition: Condition, nameOf: NameOf): string {
  const field = trigger.fields.find((candidate) => candidate.name === condition.field);
  const label = (field?.label ?? condition.field).toLowerCase();
  const picker = refPicker(trigger, condition.field);
  if (picker && typeof condition.value === 'string') {
    const name = nameOf(picker, condition.value) ?? (picker === 'tasklist' ? 'a chosen list' : 'a chosen routine');
    if (condition.operator === 'equals') return picker === 'tasklist' ? `in ${name}` : `of ${name}`;
    if (condition.operator === 'notEquals') return picker === 'tasklist' ? `not in ${name}` : `not of ${name}`;
  }
  switch (condition.operator) {
    case 'equals':
      return `with ${label} ${quoted(condition.value)}`;
    case 'notEquals':
      return `with ${label} other than ${quoted(condition.value)}`;
    case 'contains':
      return `with ${label} containing ${quoted(condition.value)}`;
    case 'notContains':
      return `with ${label} not containing ${quoted(condition.value)}`;
    case 'greaterThan':
      return `with ${label} above ${condition.value}`;
    case 'lessThan':
      return `with ${label} below ${condition.value}`;
    case 'isEmpty':
      return `without ${label}`;
    case 'isNotEmpty':
      return `with a ${label}`;
    default:
      return `with ${label} ${condition.operator} ${quoted(condition.value)}`;
  }
}

/**
 * The trigger sentence: the manifest's sentence with `{filter}` as the conditions in words and any
 * other `{field}` as the value it is checked against (`When {routineName} fails` → `When "Backup"
 * fails`, or `When any routine fails` without one).
 *
 * @example eventTriggerSentence(catalog, { type: 'event', event: 'task.completed', filter: [{ field: 'listId', operator: 'equals', value: workId }] }, names)
 * // → 'When a task in Work is completed'
 */
export function eventTriggerSentence(catalog: Pick<Catalog, 'trigger'>, trigger: { event: string; filter?: Condition[] }, nameOf: NameOf = () => undefined): string {
  const spec = catalog.trigger(trigger.event);
  if (!spec) return `When ${eventWords(trigger.event)}`;
  let rest = [...(trigger.filter ?? [])];
  const sentence = spec.sentence.replace(/\{([a-zA-Z0-9]+)\}/g, (_match, name: string) => {
    if (name === 'filter') return '{filter}';
    // `{routineName}` reads the routine picked for routineId, or a name typed for routineName
    const idField = name.replace(/Name$/, 'Id');
    const condition = rest.find((candidate) => candidate.operator === 'equals' && (candidate.field === name || candidate.field === idField));
    if (condition) {
      rest = rest.filter((candidate) => candidate !== condition);
      const picker = refPicker(spec, condition.field);
      const value = picker && typeof condition.value === 'string' ? nameOf(picker, condition.value) : condition.value;
      if (value !== undefined) return quoted(value);
      return picker === 'routine' ? 'a chosen routine' : picker === 'tasklist' ? 'a chosen list' : 'a chosen one';
    }
    const label = spec.fields.find((field) => field.name === name)?.label ?? name;
    return `any ${label.toLowerCase().replace(/ name$/, '')}`;
  });
  const words = rest.map((condition) => conditionWords(spec, condition, nameOf)).join(' and ');
  // a sentence without {filter} still names every condition – at its end
  if (!sentence.includes('{filter}')) return words ? `${sentence} ${words}` : sentence;
  return sentence.replace(/\s*\{filter\}/, words ? ` ${words}` : '');
}

/**
 * A trigger type in words: `task.completed` → `task completed`, `budget.incomeRecorded` → `budget income recorded`.
 *
 * @example eventWords('home.shoppingItemAdded') // → 'home shopping item added'
 */
export function eventWords(type: string): string {
  return type.replace('.', ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * The pills a step of an event-triggered routine can insert: one per event field.
 *
 * @example eventReferences(catalog.trigger('task.completed')) // → { '{{trigger.event.title}}': 'Title', … }
 */
export function eventReferences(trigger: { fields: OutputField[] } | undefined): Record<string, string> {
  return Object.fromEntries((trigger?.fields ?? []).map((field) => [`{{trigger.event.${field.name}}}`, field.label]));
}

/** Fields that name what an event is about, in order of preference. */
const HEADLINE_FIELDS = ['title', 'name', 'routineName', 'label', 'value'];

/**
 * What a run says about the event that started it: *Started by "task completed: Write report"*.
 *
 * @example startedBy({ event: 'task.completed', data: { title: 'Write report' } }) // → 'task completed: Write report'
 */
export function startedBy(triggerEvent: { event: string; data: Record<string, unknown> }): string {
  const headline = HEADLINE_FIELDS.map((field) => triggerEvent.data[field]).find((value) => typeof value === 'string' && value !== '');
  return headline ? `${eventWords(triggerEvent.event)}: ${headline}` : eventWords(triggerEvent.event);
}

/** The event's fields with their labels and values, for "Why did this run?" (no ids, nothing empty). */
export function eventFacts(catalog: Pick<Catalog, 'trigger'>, triggerEvent: { event: string; data: Record<string, unknown> }): Array<{ label: string; value: string }> {
  const spec = catalog.trigger(triggerEvent.event);
  return (spec?.fields ?? [])
    .filter((field) => field.type !== 'ref' && field.name !== 'taskId' && field.name !== 'notificationId')
    .map((field) => ({ label: field.label, value: triggerEvent.data[field.name] }))
    .filter((fact): fact is { label: string; value: string | number | boolean } => ['string', 'number', 'boolean'].includes(typeof fact.value) && fact.value !== '')
    .map((fact) => ({ label: fact.label, value: String(fact.value) }));
}

/** A trigger-service decision in words. */
export const DECISION_WORDS: Record<'started' | 'filtered' | 'loop' | 'inactive', string> = {
  started: 'Matched – the routine was started',
  filtered: 'Did not pass the conditions',
  loop: 'Stopped – the routine caused this event itself, or routines kept starting each other',
  inactive: 'The routine was switched off',
};
