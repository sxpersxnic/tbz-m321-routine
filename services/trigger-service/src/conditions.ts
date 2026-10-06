/**
 * The condition operators of event trigger filters – the same semantics as routine-service's
 * `condition.if` (domain/control.ts). Services share no code, so both implement them and both test
 * against contracts/fixtures/conditions.json.
 */
import type { Condition } from './messages.ts';

/** A comparison that cannot be made (`greaterThan` on text, an unknown operator). */
export class ConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionError';
  }
}

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

/** A list contains an equal item; text contains text, ignoring case. */
function contains(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((item) => equal(item, needle));
  return text(haystack).toLowerCase().includes(text(needle).toLowerCase());
}

function compare(left: unknown, right: unknown, operator: 'greaterThan' | 'lessThan'): boolean {
  const a = numeric(left);
  const b = numeric(right);
  if (a === null || b === null) throw new ConditionError(`"${operator}" needs two numbers`);
  return operator === 'greaterThan' ? a > b : a < b;
}

/**
 * Evaluates one comparison. Throws ConditionError when it cannot be made.
 *
 * @example evaluate('contains', 'Pay the RENT', 'rent') // → true
 */
export function evaluate(operator: string, left: unknown, right: unknown): boolean {
  switch (operator) {
    case 'equals':
      return equal(left, right);
    case 'notEquals':
      return !equal(left, right);
    case 'contains':
      return contains(left, right);
    case 'notContains':
      return !contains(left, right);
    case 'greaterThan':
    case 'lessThan':
      return compare(left, right, operator);
    case 'isEmpty':
      return isEmpty(left);
    case 'isNotEmpty':
      return !isEmpty(left);
    default:
      throw new ConditionError(`unknown operator "${operator}"`);
  }
}

/**
 * Whether event data passes every condition (no conditions = every event). A comparison that
 * cannot be made does not match.
 *
 * @example filterMatches([{ field: 'listId', operator: 'equals', value: 'abc' }], { listId: 'abc' }) // → true
 */
export function filterMatches(filter: Condition[], data: Record<string, unknown>): boolean {
  return filter.every(({ field, operator, value }) => {
    try {
      return evaluate(operator, data[field], value);
    } catch (error) {
      if (error instanceof ConditionError) return false;
      throw error;
    }
  });
}
