import { KNOWN_ACTION_TYPES } from './action-catalog.ts';
import { DEFAULT_TIMEZONE, validateSchedule } from './schedule.ts';
import { referencedActionKeys, templatePaths } from './templates.ts';

export type TriggerDefinition = { type: 'manual' } | { type: 'schedule'; cron: string; timezone: string } | { type: 'webhook' };
export type TriggerType = TriggerDefinition['type'];

export interface ActionDefinition {
  key: string;
  type: string;
  step: number;
  params: Record<string, unknown>;
}

export interface RoutineInput {
  name: string;
  description?: string;
  trigger: { type: 'manual' } | { type: 'schedule'; cron: string; timezone?: string } | { type: 'webhook' };
  actions: Array<{ key: string; type: string; step?: number; params?: Record<string, unknown> }>;
}

export interface RoutineDefinition {
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

const TEMPLATE_ROOTS = new Set(['actions', 'routine', 'execution', 'trigger', 'now']);

/**
 * Validates and normalises a routine. Actions without an explicit `step` run
 * after the previous action (step + 1); actions sharing a step run in parallel.
 */
export function validateRoutine(input: RoutineInput): RoutineDefinition {
  const issues: string[] = [];
  const name = input.name.trim();
  if (name === '') issues.push('name must not be blank');

  let previousStep = 0;
  const actions: ActionDefinition[] = input.actions.map((action) => {
    const step = action.step ?? previousStep + 1;
    previousStep = step;
    return { key: action.key, type: action.type, step, params: action.params ?? {} };
  });
  // stable sort keeps the author's order within a step
  actions.sort((a, b) => a.step - b.step);

  const stepByKey = new Map<string, number>();
  for (const action of actions) {
    if (stepByKey.has(action.key)) issues.push(`duplicate action key "${action.key}"`);
    stepByKey.set(action.key, action.step);
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
    for (const path of templatePaths(action.params)) {
      if (!TEMPLATE_ROOTS.has(path.split('.')[0])) issues.push(`action "${action.key}": unknown template root in "{{${path}}}"`);
      // only a webhook call carries a body – anywhere else the reference could never resolve
      if ((path === 'trigger.body' || path.startsWith('trigger.body.')) && input.trigger.type !== 'webhook') {
        issues.push(`action "${action.key}": "{{${path}}}" is only available for webhook triggers`);
      }
    }
    for (const reference of referencedActionKeys(action.params)) {
      const referencedStep = stepByKey.get(reference);
      if (referencedStep === undefined) {
        issues.push(`action "${action.key}": references unknown action "${reference}"`);
      } else if (referencedStep >= action.step) {
        issues.push(`action "${action.key}": can only reference actions of earlier steps, "${reference}" runs in step ${referencedStep}`);
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
  return { name, description: input.description?.trim() ?? '', trigger, actions };
}
