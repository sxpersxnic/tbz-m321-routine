/**
 * Text and list steps (06-engine §9): Scripting for words and lists – formatting, replacing,
 * splitting, picking, counting, filtering, sorting, reading JSON. Like the other scripting steps
 * they only compute from their (already resolved) params, so the engine evaluates them itself.
 * Pure functions, fully unit tested.
 */
import { CONDITION_OPERATORS, ControlError, evaluateCondition, type ConditionOperator, type Output } from './control.ts';

/** The longest text a step makes or reads – a routine step is not a document store. */
export const MAX_TEXT = 100_000;

const asText = (value: unknown): string => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value));

function text(value: unknown, name: string): string {
  const result = asText(value);
  if (result.length > MAX_TEXT) throw new ControlError(`"${name}" is longer than ${MAX_TEXT} characters`);
  return result;
}

function list(value: unknown, name: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new ControlError(`"${name}" must be a list, got ${value === null || value === undefined ? 'nothing' : typeof value}`);
}

/** `item.field.sub` – a field of a list item; no field = the item itself. */
function fieldOf(item: unknown, field: unknown): unknown {
  if (typeof field !== 'string' || field.trim() === '') return item;
  let current: unknown = item;
  for (const segment of field.trim().split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The template is resolved by the engine before the step runs – what is left is the text itself. */
export function formatText(params: Record<string, unknown>): Output {
  return { text: text(params.template, 'template') };
}

export function replaceText(params: Record<string, unknown>): Output {
  const source = text(params.text, 'text');
  const find = asText(params.find);
  if (find === '') throw new ControlError('"find" must not be empty');
  const replaceWith = asText(params.replaceWith);
  const result = params.all === false ? source.replace(find, () => replaceWith) : source.split(find).join(replaceWith);
  return { text: text(result, 'text') };
}

/** Pieces trimmed, empty ones left out: "a, b,,c" → ["a", "b", "c"]. */
export function splitText(params: Record<string, unknown>): Output {
  const separator = params.separator === undefined || params.separator === null || params.separator === '' ? ',' : asText(params.separator);
  return { items: text(params.text, 'text').split(separator).map((piece) => piece.trim()).filter((piece) => piece !== '') };
}

/** `first`, `last`, or a position counted from 1 (people count from 1). */
export function getItem(params: Record<string, unknown>): Output {
  const items = list(params.list, 'list');
  const position = params.position === undefined || params.position === '' ? 'first' : params.position;
  if (items.length === 0) throw new ControlError('the list is empty');
  if (position === 'first') return { item: items[0] };
  if (position === 'last') return { item: items[items.length - 1] };
  const n = Number(position);
  if (!Number.isInteger(n) || n < 1) throw new ControlError(`"position" must be first, last or a number from 1, got ${asText(position)}`);
  if (n > items.length) throw new ControlError(`the list has ${items.length} item(s), there is no item ${n}`);
  return { item: items[n - 1] };
}

export function countItems(params: Record<string, unknown>): Output {
  return { count: list(params.list, 'list').length };
}

/**
 * Keeps the items whose field compares like an If step would (same operators, same rules). An item
 * that can't be compared (no number where one is needed) doesn't match – it isn't an error.
 */
export function filterItems(params: Record<string, unknown>): Output {
  const operator = (params.operator ?? 'equals') as ConditionOperator;
  if (!CONDITION_OPERATORS.includes(operator)) throw new ControlError(`unknown operator "${String(operator)}"`);
  const matches = (item: unknown) => {
    try {
      return evaluateCondition({ left: fieldOf(item, params.field), operator, right: params.value }).result === true;
    } catch (error) {
      if (error instanceof ControlError) return false;
      throw error;
    }
  };
  const items = list(params.list, 'list').filter(matches);
  return { items, count: items.length };
}

/** Numbers by value, everything else as text (case-insensitive, en-GB); missing fields last. Stable. */
export function sortItems(params: Record<string, unknown>): Output {
  const direction = params.direction === 'desc' ? -1 : 1;
  const key = (item: unknown) => fieldOf(item, params.field);
  const compare = (a: unknown, b: unknown): number => {
    if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
    if (b === undefined || b === null) return -1;
    const x = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : Number.NaN;
    const y = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : Number.NaN;
    if (Number.isFinite(x) && Number.isFinite(y)) return (x - y) * direction;
    return asText(a).localeCompare(asText(b), 'en-GB', { sensitivity: 'base' }) * direction;
  };
  return { items: [...list(params.list, 'list')].sort((a, b) => compare(key(a), key(b))) };
}

export function parseJson(params: Record<string, unknown>): Output {
  // already a value (a reference to an object) – nothing to read
  if (typeof params.text !== 'string') return { value: params.text ?? null };
  try {
    return { value: JSON.parse(text(params.text, 'text')) as unknown };
  } catch (error) {
    throw new ControlError(`"text" is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const TEXT_LIST_EVALUATORS: Record<string, (params: Record<string, unknown>) => Output> = {
  'text.format': formatText,
  'text.replace': replaceText,
  'text.split': splitText,
  'list.get': getItem,
  'list.count': countItems,
  'list.filter': filterItems,
  'list.sort': sortItems,
  'json.parse': parseJson,
};
