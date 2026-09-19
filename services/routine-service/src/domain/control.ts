/**
 * Scripting actions – like the "Scripting" category in Apple's Shortcuts. They
 * only compute a value from their (already resolved) params, so the engine
 * evaluates them itself inside the execution's transaction instead of sending
 * them through the broker: no worker, no retries, no side effects.
 *
 * Pure functions, fully unit tested.
 */

export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlError';
  }
}

export type Output = Record<string, unknown>;

export const CONDITION_OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'greaterThan',
  'lessThan',
  'isEmpty',
  'isNotEmpty',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const MATH_OPERATORS = ['+', '-', '*', '/', '%', 'min', 'max', 'round'] as const;
export type MathOperator = (typeof MATH_OPERATORS)[number];

const text = (value: unknown): string => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value));

/** A number from a number or a numeric string ("42", " 3.5 "); null otherwise. */
function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** Equal as numbers when both are numeric (so "5" equals 5), else as text. */
function equal(left: unknown, right: unknown): boolean {
  const a = numeric(left);
  const b = numeric(right);
  if (a !== null && b !== null) return a === b;
  return text(left) === text(right);
}

function contains(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((item) => equal(item, needle));
  return text(haystack).toLowerCase().includes(text(needle).toLowerCase());
}

function compare(left: unknown, right: unknown, operator: 'greaterThan' | 'lessThan'): boolean {
  const a = numeric(left);
  const b = numeric(right);
  if (a === null || b === null) throw new ControlError(`"${operator}" needs two numbers, got ${text(left) || 'nothing'} and ${text(right) || 'nothing'}`);
  return operator === 'greaterThan' ? a > b : a < b;
}

export function evaluateCondition(params: Record<string, unknown>): Output {
  const operator = params.operator as ConditionOperator;
  const { left, right } = params;
  let result: boolean;
  switch (operator) {
    case 'equals':
      result = equal(left, right);
      break;
    case 'notEquals':
      result = !equal(left, right);
      break;
    case 'contains':
      result = contains(left, right);
      break;
    case 'notContains':
      result = !contains(left, right);
      break;
    case 'greaterThan':
    case 'lessThan':
      result = compare(left, right, operator);
      break;
    case 'isEmpty':
      result = isEmpty(left);
      break;
    case 'isNotEmpty':
      result = !isEmpty(left);
      break;
    default:
      throw new ControlError(`unknown operator "${String(operator)}"`);
  }
  return { result };
}

export function setVariable(params: Record<string, unknown>): Output {
  const name = params.name;
  if (typeof name !== 'string' || !VARIABLE_NAME.test(name)) throw new ControlError('param "name" must be a variable name (letters, digits, _)');
  return { name, value: params.value ?? '' };
}

export function calculate(params: Record<string, unknown>): Output {
  const operator = params.operator as MathOperator;
  const a = numeric(params.a);
  if (a === null) throw new ControlError(`"${text(params.a) || 'nothing'}" is not a number`);
  if (operator === 'round') {
    const digits = numeric(params.b) ?? 0;
    const factor = 10 ** Math.max(0, Math.min(10, Math.trunc(digits)));
    return { result: Math.round(a * factor) / factor };
  }
  const b = numeric(params.b);
  if (b === null) throw new ControlError(`"${text(params.b) || 'nothing'}" is not a number`);
  switch (operator) {
    case '+':
      return { result: a + b };
    case '-':
      return { result: a - b };
    case '*':
      return { result: a * b };
    case '/':
      if (b === 0) throw new ControlError('division by zero');
      return { result: a / b };
    case '%':
      if (b === 0) throw new ControlError('division by zero');
      return { result: a % b };
    case 'min':
      return { result: Math.min(a, b) };
    case 'max':
      return { result: Math.max(a, b) };
    default:
      throw new ControlError(`unknown operator "${String(operator)}"`);
  }
}

export const VARIABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/;

const EVALUATORS: Record<string, (params: Record<string, unknown>) => Output> = {
  'condition.if': evaluateCondition,
  'variable.set': setVariable,
  'math.calculate': calculate,
};

/** Types the engine evaluates itself. */
export const CONTROL_ACTION_TYPES: ReadonlySet<string> = new Set(Object.keys(EVALUATORS));

export function evaluateControlAction(type: string, params: Record<string, unknown>): Output {
  const evaluate = EVALUATORS[type];
  if (!evaluate) throw new ControlError(`${type} is not a scripting action`);
  return evaluate(params);
}

/** Whether a step with `runIf` runs: its condition step must have run and produced the expected result. */
export function conditionMet(condition: { status: string; output: Record<string, unknown> | null }, expected: boolean): boolean {
  return condition.status === 'COMPLETED' && condition.output?.result === expected;
}
