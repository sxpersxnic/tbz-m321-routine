import { ACTION_FORMS, actionShort, describeReference, sentencePlain } from '../action-forms.ts';
import { describeTrigger } from '../format.ts';
import { COLOR_CHOICES, ICON_CHOICES } from '../looks.ts';
import type { ActionDefinition, VersionDefinition, VersionOrigin } from '../types.ts';

/**
 * Plain-language version diff (docs/v2/07-web.md §8): what changed between two versions of a routine,
 * as sentences in the order a person checks them – name and start, then the steps (matched by key),
 * then the settings.
 */
export function describeChanges(before: VersionDefinition | null, after: VersionDefinition, origin: VersionOrigin): string[] {
  if (!before) return origin === 'create' ? ['Created'] : [];
  const changes: string[] = [];

  // what the kind of write already says (the definition itself doesn't change)
  if (origin === 'webhook') changes.push('Webhook address changed');
  if (before.active !== after.active) changes.push(after.active ? 'Turned on' : 'Turned off');

  if (before.name !== after.name) changes.push(`Renamed from "${before.name}" to "${after.name}"`);
  if (before.description !== after.description) changes.push(after.description ? 'Changed the description' : 'Removed the description');
  changes.push(...triggerChanges(before, after));
  changes.push(...stepChanges(before.actions, after.actions));

  const color = (tint: string | null) => (tint ? (COLOR_CHOICES.find((choice) => choice.tint === tint)?.label ?? tint) : 'automatic');
  const icon = (name: string | null) => (name ? (ICON_CHOICES.find((choice) => choice.name === name)?.label ?? name) : 'automatic');
  if (before.color !== after.color) changes.push(`Colour changed to ${color(after.color)}`);
  if (before.icon !== after.icon) changes.push(`Symbol changed to ${icon(after.icon)}`);

  if (changes.length === 0 && origin !== 'activate' && origin !== 'deactivate') changes.push('Saved without changes');
  return changes;
}

/** "Every Monday at 08:00" → "every Monday at 08:00", for the middle of a sentence. */
const midSentence = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function triggerChanges(before: VersionDefinition, after: VersionDefinition): string[] {
  const from = midSentence(describeTrigger(before.trigger));
  const to = midSentence(describeTrigger(after.trigger));
  if (before.trigger.type === 'schedule' && after.trigger.type === 'schedule') {
    const changes: string[] = [];
    if (before.trigger.cron !== after.trigger.cron) changes.push(from === to ? 'Schedule changed' : `Schedule changed from ${from} to ${to}`);
    if (before.trigger.timezone !== after.trigger.timezone) changes.push(`Time zone changed from ${before.trigger.timezone} to ${after.trigger.timezone}`);
    return changes;
  }
  return before.trigger.type === after.trigger.type ? [] : [`Start changed from ${from} to ${to}`];
}

// ---------------------------------------------------------------- steps

/** Steps in run order: by step, then as listed. */
const inOrder = (actions: ActionDefinition[]) => actions.map((action, index) => ({ action, index })).sort((a, b) => a.action.step - b.action.step || a.index - b.index).map(({ action }) => action);

/** The keys of the longest common subsequence – the steps that kept their relative order. */
function keptOrder(before: string[], after: string[]): Set<string> {
  const table = before.map(() => after.map(() => 0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j] ? 1 + (table[i + 1]?.[j + 1] ?? 0) : Math.max(table[i + 1]?.[j] ?? 0, table[i]?.[j + 1] ?? 0);
    }
  }
  const kept = new Set<string>();
  for (let i = 0, j = 0; i < before.length && j < after.length; ) {
    if (before[i] === after[j]) {
      kept.add(before[i]);
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return kept;
}

/** The steps (present in both versions) that run in parallel with `action` – as a comparable key. */
function partners(actions: ActionDefinition[], action: ActionDefinition | undefined, common: Map<string, ActionDefinition>): string {
  if (!action) return '';
  return actions.filter((other) => other.step === action.step && other.key !== action.key && common.has(other.key)).map((other) => other.key).sort().join(',');
}

function stepChanges(beforeActions: ActionDefinition[], afterActions: ActionDefinition[]): string[] {
  const changes: string[] = [];
  const before = new Map(beforeActions.map((action) => [action.key, action]));
  const after = new Map(afterActions.map((action) => [action.key, action]));
  const typesBefore = Object.fromEntries(beforeActions.map((action) => [action.key, action.type]));
  const typesAfter = Object.fromEntries(afterActions.map((action) => [action.key, action.type]));
  // "Get weather" is enough while there is one; with two of a kind, the sentence tells them apart
  const name = (action: ActionDefinition, types: Record<string, string>, all: ActionDefinition[]) =>
    all.filter((other) => other.type === action.type).length > 1 ? sentencePlain(action.type, action.params, types) : actionShort(action.type);

  for (const action of beforeActions) {
    if (!after.has(action.key)) changes.push(`Removed step: ${sentencePlain(action.type, action.params, typesBefore)}`);
  }
  for (const action of afterActions) {
    if (!before.has(action.key)) changes.push(`Added step: ${sentencePlain(action.type, action.params, typesAfter)}`);
  }

  // moved: steps that left the common order, named after the step they now follow
  const orderBefore = inOrder(beforeActions).map((action) => action.key).filter((key) => after.has(key));
  const orderAfter = inOrder(afterActions).map((action) => action.key).filter((key) => before.has(key));
  const kept = keptOrder(orderBefore, orderAfter);
  // "A now runs together with B" already says it for B
  const mentioned = new Set<string>();
  for (const [index, key] of orderAfter.entries()) {
    const action = after.get(key);
    if (!action) continue;
    if (!kept.has(key)) {
      const previous = index > 0 ? after.get(orderAfter[index - 1]) : undefined;
      changes.push(previous ? `Moved ${name(action, typesAfter, afterActions)} after ${name(previous, typesAfter, afterActions)}` : `Moved ${name(action, typesAfter, afterActions)} to the start`);
    } else if (!mentioned.has(key) && partners(beforeActions, before.get(key), after) !== partners(afterActions, action, before)) {
      // runs with other steps now, or alone now – a step number that only shifted says nothing
      const together = afterActions.filter((other) => other.step === action.step && other.key !== key);
      for (const other of [action, ...together]) mentioned.add(other.key);
      changes.push(together.length > 0
        ? `${name(action, typesAfter, afterActions)} now runs together with ${together.map((other) => name(other, typesAfter, afterActions)).join(' and ')}`
        : `${name(action, typesAfter, afterActions)} now runs on its own`);
    }
  }

  for (const action of afterActions) {
    const old = before.get(action.key);
    if (!old) continue;
    const label = name(action, typesAfter, afterActions);
    if (old.type !== action.type) {
      changes.push(`Replaced ${name(old, typesBefore, beforeActions)} with ${actionShort(action.type)}`);
      continue;
    }
    changes.push(...paramChanges(old, action, typesBefore, typesAfter, label, afterActions.filter((other) => other.type === action.type).length > 1));
    if (JSON.stringify(old.runIf ?? null) !== JSON.stringify(action.runIf ?? null)) {
      changes.push(action.runIf ? `${label} now depends on a condition` : `${label} no longer depends on a condition`);
    }
    if ((old.forEach ?? '') !== (action.forEach ?? '')) {
      changes.push(action.forEach ? `${label} now repeats for each ${describeReference(action.forEach, typesAfter, false)}` : `${label} no longer repeats`);
    }
  }
  return changes;
}

// ---------------------------------------------------------------- params

/** A param value in words: references named, choices by their label, nothing as "nothing". */
function display(value: unknown, field: { optionLabels?: Record<string, string> } | undefined, types: Record<string, string>): string {
  if (value === undefined || value === null || value === '') return 'nothing';
  if (typeof value === 'string') {
    const label = field?.optionLabels?.[value];
    if (label) return label;
    return value.replace(/\{\{[^}]+\}\}/g, (reference) => describeReference(reference, types, false));
  }
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

function paramChanges(
  old: ActionDefinition,
  action: ActionDefinition,
  typesBefore: Record<string, string>,
  typesAfter: Record<string, string>,
  label: string,
  ambiguous: boolean,
): string[] {
  const fields = ACTION_FORMS[action.type]?.fields ?? [];
  const names = [...new Set([...fields.map((field) => field.name), ...Object.keys(old.params), ...Object.keys(action.params)])];
  const where = ambiguous ? ` in ${label}` : '';
  const changes: string[] = [];
  for (const param of names) {
    // routine.run keeps the routine's name next to its id only for display
    if (action.type === 'routine.run' && param === 'routineName') continue;
    const was = old.params[param];
    const now = action.params[param];
    if (JSON.stringify(was ?? null) === JSON.stringify(now ?? null)) continue;
    const field = fields.find((candidate) => candidate.name === param);
    const what = (field?.label ?? param).toLowerCase();
    if (action.type === 'routine.run' && param === 'routineId') {
      changes.push(`Now runs routine "${String(action.params.routineName ?? '?')}" instead of "${String(old.params.routineName ?? '?')}"`);
      continue;
    }
    changes.push(`Changed ${what}${where} from ${display(was, field, typesBefore)} to ${display(now, field, typesAfter)}`);
  }
  return changes;
}

/**
 * The older version a restore brought back, if its definition matches one exactly – for "Restored
 * version 5". `versions` newest first, as the API lists them.
 */
export function restoredFrom(versions: Array<{ version: number; definition: VersionDefinition }>, index: number): number | undefined {
  const { active: _active, ...restored } = versions[index].definition;
  const same = JSON.stringify(restored);
  return versions.slice(index + 1).find(({ definition }) => {
    const { active: _other, ...candidate } = definition;
    return JSON.stringify(candidate) === same;
  })?.version;
}
