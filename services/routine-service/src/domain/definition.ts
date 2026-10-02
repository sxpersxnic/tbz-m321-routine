import type { ParamSpec } from '@routine/service-kit';
import { BUILTIN_CATALOG, type Catalog, type CatalogCapability } from './catalog.ts';
import { VARIABLE_NAME } from './control.ts';
import { DEFAULT_TIMEZONE, validateSchedule } from './schedule.ts';
import { referencedActionKeys, templatePaths } from './templates.ts';

export type TriggerDefinition = { type: 'manual' } | { type: 'schedule'; cron: string; timezone: string } | { type: 'webhook' };
export type TriggerType = TriggerDefinition['type'];
/** How an execution started: a routine's own trigger, or a `routine.run` step of another routine. */
export type ExecutionTrigger = TriggerType | 'routine';

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
  /** "If you don't get to it" – human steps only: after `after` (ISO 8601 duration) the step is skipped or fails. */
  timeout?: StepTimeout;
}

export interface StepTimeout {
  after: string;
  then: 'skip' | 'fail';
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
  actions: Array<{ key: string; type: string; step?: number; params?: Record<string, unknown>; runIf?: RunIf; forEach?: string; timeout?: StepTimeout }>;
  /** Tell the owner after this many failures in a row; null = never; omitted = unchanged (2 for a new routine). */
  alertAfterFailures?: number | null;
}

export interface RoutineDefinition extends Appearance {
  name: string;
  description: string;
  trigger: TriggerDefinition;
  actions: ActionDefinition[];
  /** undefined = leave as it is (on create: 2). */
  alertAfterFailures?: number | null;
}

export class DefinitionError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`invalid routine definition: ${issues.join('; ')}`);
    this.name = 'DefinitionError';
    this.issues = issues;
  }
}

const TEMPLATE_ROOTS = new Set(['actions', 'routine', 'execution', 'trigger', 'now', 'vars', 'item', 'index', 'input']);
const LOOP_ROOTS = new Set(['item', 'index']);
const SINGLE_REFERENCE = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/;
const EARLIER_STEPS_ONLY = 'can only reference actions of earlier steps';

/**
 * Validates and normalises a routine. Actions without an explicit `step` run
 * after the previous action (step + 1); actions sharing a step run in parallel.
 */
/** The one scripting rule a manifest can't say: variable names must work in `{{vars.<name>}}`. */
function scriptingIssues(action: ActionDefinition): string[] {
  const { name } = action.params;
  if (action.type === 'variable.set' && (typeof name !== 'string' || !VARIABLE_NAME.test(name))) {
    return [`action "${action.key}": variable name must start with a letter and use only letters, digits and _`];
  }
  return [];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4}-\d{2}-\d{2}|\+\d+d)$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

const asNumber = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);

/** Why one param value doesn't fit its spec (04 §2.1), or null. Templated values are checked at run time. */
function valueIssue(param: ParamSpec, value: unknown): string | null {
  if (typeof value === 'string' && value.includes('{{') && param.templating !== false) return null;
  const range = (n: number) =>
    param.min !== undefined && n < param.min ? `must be at least ${param.min}` : param.max !== undefined && n > param.max ? `must be at most ${param.max}` : null;
  switch (param.type) {
    case 'number':
    case 'money': {
      const n = asNumber(value);
      return Number.isFinite(n) ? range(n) : 'must be a number';
    }
    case 'integer': {
      const n = asNumber(value);
      return Number.isInteger(n) ? range(n) : 'must be a whole number';
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'choice':
      return (param.options ?? []).some((option) => option.value === String(value)) ? null : `unknown`;
    case 'ref':
      return typeof value === 'string' && UUID.test(value) ? null : `must be a ${param.ref?.collection ?? 'item'} id`;
    case 'date':
      return typeof value === 'string' && DATE.test(value) ? null : 'must be a date (YYYY-MM-DD or +Nd)';
    case 'time':
      return typeof value === 'string' && TIME.test(value) ? null : 'must be a time (HH:mm)';
    case 'duration':
      return typeof value === 'string' && DURATION.test(value) ? null : 'must be a duration like PT2H';
    case 'list':
      return Array.isArray(value) ? null : 'must be a list';
    case 'object':
      return value && typeof value === 'object' && !Array.isArray(value) ? null : 'must be an object';
    default:
      return null;
  }
}

/** Required params present, literal values well-formed (04 §2.1). Unknown params stay allowed (additive). */
function paramIssues(action: ActionDefinition, capability: CatalogCapability): string[] {
  const issues: string[] = [];
  for (const param of capability.params) {
    const value = action.params[param.name];
    if (value === undefined || value === null || value === '') {
      if (param.required) issues.push(`action "${action.key}": missing required param "${param.name}"`);
      continue;
    }
    const issue = valueIssue(param, value);
    if (issue === 'unknown') issues.push(`action "${action.key}": unknown ${param.label.toLowerCase()} "${String(value)}"`);
    else if (issue) issues.push(`action "${action.key}": "${param.name}" ${issue}`);
  }
  return issues;
}

export function validateRoutine(input: RoutineInput, catalog: Catalog = BUILTIN_CATALOG): RoutineDefinition {
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
      // biome-ignore lint/suspicious/noThenProperty: the field is named "then" in the routine definition (06-engine §2)
      ...(action.timeout ? { timeout: { after: action.timeout.after, then: action.timeout.then } } : {}),
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
    const capability = catalog.capability(action.type);
    if (!capability) {
      issues.push(`action "${action.key}": unknown type "${action.type}"`);
      continue;
    }
    issues.push(...paramIssues(action, capability));
    issues.push(...scriptingIssues(action));
    if (action.timeout) {
      if (capability.kind !== 'human') issues.push(`action "${action.key}": only steps you do yourself can time out`);
      else if (!DURATION.test(action.timeout.after)) issues.push(`action "${action.key}": the time to wait must be a duration like PT2H`);
      else if (action.timeout.then !== 'skip' && action.timeout.then !== 'fail') issues.push(`action "${action.key}": after the wait the step is skipped or fails`);
    }
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

  const alert = input.alertAfterFailures;
  if (alert !== undefined && alert !== null && (!Number.isInteger(alert) || alert < 1 || alert > 10)) {
    issues.push('alertAfterFailures must be a whole number from 1 to 10, or null for never');
  }

  if (issues.length > 0) throw new DefinitionError(issues);
  return {
    name,
    description: input.description?.trim() ?? '',
    trigger,
    actions,
    icon: input.icon,
    color: input.color,
    ...(alert !== undefined && { alertAfterFailures: alert }),
  };
}
