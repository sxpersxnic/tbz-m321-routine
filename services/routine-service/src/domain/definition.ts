import { KNOWN_ACTION_TYPES } from './action-catalog.ts';
import { CONDITION_OPERATORS, MATH_OPERATORS, VARIABLE_NAME } from './control.ts';
import { DEFAULT_TIMEZONE, validateSchedule } from './schedule.ts';
import { referencedActionKeys, templatePaths } from './templates.ts';

export type TriggerDefinition = { type: 'manual' } | { type: 'schedule'; cron: string; timezone: string } | { type: 'webhook' };
export type TriggerType = TriggerDefinition['type'];

/** Run a step only if an earlier `condition.if` step produced `is`. */
export interface RunIf {
  action: string;
  is: boolean;
}

export interface ActionDefinition {
  key: string;
  type: string;
  step: number;
  params: Record<string, unknown>;
  runIf?: RunIf;
  /** A single `{{…}}` reference to a list: the step runs once per item, readable as {{item}} / {{index}}. */
  forEach?: string;
}

/** Colours the client knows; icons are free-form names from the client's icon set. */
export const ROUTINE_COLORS = ['sky', 'indigo', 'violet', 'pink', 'orange', 'green', 'teal', 'grey'] as const;
export type RoutineColor = (typeof ROUTINE_COLORS)[number];

/** `undefined` = leave as it is, `null` = back to the look of the first action. */
export interface Appearance {
  icon?: string | null;
  color?: RoutineColor | null;
}

export interface RoutineInput extends Appearance {
  name: string;
  description?: string;
  trigger: { type: 'manual' } | { type: 'schedule'; cron: string; timezone?: string } | { type: 'webhook' };
  actions: Array<{ key: string; type: string; step?: number; params?: Record<string, unknown>; runIf?: RunIf; forEach?: string }>;
}

export interface RoutineDefinition extends Appearance {
  name: string;
  description: string;
  trigger: TriggerDefinition;
  actions: ActionDefinition[];
}

export class DefinitionError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`invalid routine definition: ${issues.join('; ')}`);
    this.name = 'DefinitionError';
    this.issues = issues;
  }
}

const TEMPLATE_ROOTS = new Set(['actions', 'routine', 'execution', 'trigger', 'now', 'vars', 'item', 'index']);
const LOOP_ROOTS = new Set(['item', 'index']);
const SINGLE_REFERENCE = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/;
const EARLIER_STEPS_ONLY = 'can only reference actions of earlier steps';

/**
 * Validates and normalises a routine. Actions without an explicit `step` run
 * after the previous action (step + 1); actions sharing a step run in parallel.
 */
/** Param checks of the scripting actions that go beyond "required". A `{{…}}` value is checked at run time instead. */
function scriptingIssues(action: ActionDefinition): string[] {
  const literal = (value: unknown) => typeof value === 'string' && !value.includes('{{');
  const { operator, name } = action.params;
  if (action.type === 'condition.if' && literal(operator) && !(CONDITION_OPERATORS as readonly string[]).includes(operator as string)) {
    return [`action "${action.key}": unknown comparison "${String(operator)}"`];
  }
  if (action.type === 'math.calculate' && literal(operator) && !(MATH_OPERATORS as readonly string[]).includes(operator as string)) {
    return [`action "${action.key}": unknown operator "${String(operator)}"`];
  }
  if (action.type === 'variable.set' && (typeof name !== 'string' || !VARIABLE_NAME.test(name))) {
    return [`action "${action.key}": variable name must start with a letter and use only letters, digits and _`];
  }
  return [];
}

export function validateRoutine(input: RoutineInput): RoutineDefinition {
  const issues: string[] = [];
  const name = input.name.trim();
  if (name === '') issues.push('name must not be blank');

  let previousStep = 0;
  const actions: ActionDefinition[] = input.actions.map((action) => {
    const step = action.step ?? previousStep + 1;
    previousStep = step;
    return {
      key: action.key,
      type: action.type,
      step,
      params: action.params ?? {},
      ...(action.runIf ? { runIf: action.runIf } : {}),
      ...(action.forEach ? { forEach: action.forEach.trim() } : {}),
    };
  });
  // stable sort keeps the author's order within a step
  actions.sort((a, b) => a.step - b.step);

  const stepByKey = new Map<string, number>();
  const typeByKey = new Map<string, string>();
  for (const action of actions) {
    if (stepByKey.has(action.key)) issues.push(`duplicate action key "${action.key}"`);
    stepByKey.set(action.key, action.step);
    typeByKey.set(action.key, action.type);
  }
  // variable name → earliest step that sets it (only literal names can be checked)
  const variableStep = new Map<string, number>();
  for (const action of actions) {
    const name = action.params.name;
    if (action.type === 'variable.set' && typeof name === 'string' && !variableStep.has(name)) variableStep.set(name, action.step);
  }

  for (const action of actions) {
    const info = KNOWN_ACTION_TYPES.get(action.type);
    if (!info) {
      issues.push(`action "${action.key}": unknown type "${action.type}"`);
      continue;
    }
    for (const param of info.requiredParams) {
      if (action.params[param] === undefined || action.params[param] === '') {
        issues.push(`action "${action.key}": missing required param "${param}"`);
      }
    }
    issues.push(...scriptingIssues(action));
    if (action.runIf) {
      const conditionStep = stepByKey.get(action.runIf.action);
      if (conditionStep === undefined) issues.push(`action "${action.key}": runs only if unknown action "${action.runIf.action}"`);
      else if (typeByKey.get(action.runIf.action) !== 'condition.if') issues.push(`action "${action.key}": "${action.runIf.action}" is not a condition`);
      else if (conditionStep >= action.step) issues.push(`action "${action.key}": its condition "${action.runIf.action}" must run in an earlier step`);
    }
    if (action.forEach !== undefined && !SINGLE_REFERENCE.test(action.forEach)) {
      issues.push(`action "${action.key}": "repeat for each" needs exactly one {{…}} reference to a list`);
    }
    const paths = templatePaths({ params: action.params, forEach: action.forEach });
    for (const path of paths) {
      const root = path.split('.')[0];
      if (!TEMPLATE_ROOTS.has(root)) issues.push(`action "${action.key}": unknown template root in "{{${path}}}"`);
      if (LOOP_ROOTS.has(root) && !action.forEach) issues.push(`action "${action.key}": "{{${path}}}" is only available in a step that repeats for each item`);
      if (LOOP_ROOTS.has(root) && action.forEach && templatePaths(action.forEach).includes(path)) {
        issues.push(`action "${action.key}": the list to repeat over cannot be the item itself`);
      }
      if (root === 'vars') {
        const name = path.split('.')[1];
        const setAt = name ? variableStep.get(name) : undefined;
        if (setAt === undefined) issues.push(`action "${action.key}": variable "${name ?? ''}" is never set`);
        else if (setAt >= action.step) issues.push(`action "${action.key}": variable "${name}" is set in step ${setAt}, it can only be read in later steps`);
      }
      // only a webhook call carries a body – anywhere else the reference could never resolve
      if ((path === 'trigger.body' || path.startsWith('trigger.body.')) && input.trigger.type !== 'webhook') {
        issues.push(`action "${action.key}": "{{${path}}}" is only available for webhook triggers`);
      }
    }
    for (const reference of referencedActionKeys({ params: action.params, forEach: action.forEach })) {
      const referencedStep = stepByKey.get(reference);
      if (referencedStep === undefined) {
        issues.push(`action "${action.key}": references unknown action "${reference}"`);
      } else if (referencedStep >= action.step) {
        issues.push(`action "${action.key}": ${EARLIER_STEPS_ONLY}, "${reference}" runs in step ${referencedStep}`);
      }
    }
  }

  let trigger: TriggerDefinition = { type: 'manual' };
  if (input.trigger.type === 'schedule') {
    const timezone = input.trigger.timezone ?? DEFAULT_TIMEZONE;
    issues.push(...validateSchedule(input.trigger.cron, timezone));
    trigger = { type: 'schedule', cron: input.trigger.cron, timezone };
  } else if (input.trigger.type === 'webhook') {
    trigger = { type: 'webhook' };
  }

  if (issues.length > 0) throw new DefinitionError(issues);
  return { name, description: input.description?.trim() ?? '', trigger, actions, icon: input.icon, color: input.color };
}
