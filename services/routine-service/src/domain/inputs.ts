/**
 * "Ask when run?" (06-engine §2): questions a manual routine asks each time it is run by hand, and
 * the answers, validated against them. Pure, so the API and validation share it.
 */

export type InputType = 'text' | 'number' | 'date' | 'choice' | 'ref';

export interface RoutineInputSpec {
  /** Read as {{input.<name>}}. */
  name: string;
  label: string;
  type: InputType;
  required?: boolean;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  ref?: { domain: string; collection: string };
}

export const MAX_INPUTS = 10;
export const INPUT_TYPES: readonly InputType[] = ['text', 'number', 'date', 'choice', 'ref'];
const NAME = /^[a-z][a-zA-Z0-9]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const empty = (value: unknown) => value === undefined || value === null || value === '';

/** Why one answer doesn't fit its question, or null. Numbers may come as numeric text (a form field). */
function answerIssue(spec: RoutineInputSpec, value: unknown): string | null {
  switch (spec.type) {
    case 'number':
      return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) ? null : 'must be a number';
    case 'date':
      return typeof value === 'string' && DATE.test(value) ? null : 'must be a date (YYYY-MM-DD)';
    case 'choice':
      return (spec.options ?? []).some((option) => option.value === value) ? null : 'is not one of the choices';
    case 'ref':
      return typeof value === 'string' && UUID.test(value) ? null : `must be a ${spec.ref?.collection ?? 'item'} id`;
    default:
      return typeof value === 'string' ? null : 'must be text';
  }
}

/** The issues of a routine's questions (empty = fine). */
export function inputSpecIssues(specs: RoutineInputSpec[]): string[] {
  const issues: string[] = [];
  if (specs.length > MAX_INPUTS) issues.push(`a routine can ask at most ${MAX_INPUTS} questions`);
  const names = new Set<string>();
  for (const spec of specs) {
    if (!NAME.test(spec.name)) issues.push(`question "${spec.label}": its name must start with a small letter and use only letters and digits`);
    else if (names.has(spec.name)) issues.push(`question "${spec.name}" is asked twice`);
    names.add(spec.name);
    if (!INPUT_TYPES.includes(spec.type)) issues.push(`question "${spec.name}": unknown type "${String(spec.type)}"`);
    if (spec.type === 'choice' && (spec.options ?? []).length < 2) issues.push(`question "${spec.name}": a choice needs at least 2 options`);
    if (spec.type === 'ref' && !spec.ref) issues.push(`question "${spec.name}": says what it picks from (ref)`);
    if (!empty(spec.default) && INPUT_TYPES.includes(spec.type)) {
      const issue = answerIssue(spec, spec.default);
      if (issue) issues.push(`question "${spec.name}": the default ${issue}`);
    }
  }
  return issues;
}

/**
 * The answers of one run: every question answered (or its default), numbers as numbers, nothing
 * that wasn't asked. Throws InputError listing what's wrong.
 */
export function resolveInputs(specs: RoutineInputSpec[], given: Record<string, unknown> = {}): Record<string, unknown> {
  const issues: string[] = [];
  const asked = new Set(specs.map((spec) => spec.name));
  for (const name of Object.keys(given)) if (!asked.has(name)) issues.push(`"${name}" is not a question of this routine`);
  const values: Record<string, unknown> = {};
  for (const spec of specs) {
    const value = empty(given[spec.name]) ? spec.default : given[spec.name];
    if (empty(value)) {
      if (spec.required) issues.push(`"${spec.label}" needs an answer`);
      continue;
    }
    const issue = answerIssue(spec, value);
    if (issue) issues.push(`"${spec.label}" ${issue}`);
    else values[spec.name] = spec.type === 'number' ? Number(value) : value;
  }
  if (issues.length > 0) throw new InputError(issues);
  return values;
}

export class InputError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`invalid answers: ${issues.join('; ')}`);
    this.name = 'InputError';
    this.issues = issues;
  }
}
