/**
 * Minimal template language for action params, e.g.
 *   "Heute: {{actions.weather.summary}}"
 * References are resolved when an action is dispatched, using outputs of
 * actions from earlier steps.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const SINGLE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/;

export interface TemplateScope {
  routine: { id: string; name: string };
  execution: { id: string; trigger: string; startedAt: string };
  actions: Record<string, unknown>;
  now: string;
}

export class TemplateError extends Error {
  path: string;

  constructor(path: string) {
    super(`template reference "{{${path}}}" could not be resolved`);
    this.name = 'TemplateError';
    this.path = path;
  }
}

function collectStrings(value: unknown, into: string[]): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, into));
  return into;
}

/** All `{{path}}` references used anywhere inside `value`. */
export function templatePaths(value: unknown): string[] {
  return collectStrings(value, []).flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]));
}

/** Keys of other actions referenced via `{{actions.<key>...}}`. */
export function referencedActionKeys(value: unknown): string[] {
  return [
    ...new Set(
      templatePaths(value)
        .filter((path) => path.startsWith('actions.'))
        .map((path) => path.split('.')[1])
        .filter(Boolean),
    ),
  ];
}

function lookup(scope: TemplateScope, path: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in current)) throw new TemplateError(path);
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) throw new TemplateError(path);
  return current;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Resolves all placeholders. A string that consists of exactly one placeholder
 * keeps the referenced value's type (number, object, …); otherwise the value
 * is interpolated as text.
 */
export function resolveTemplates(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') {
    const single = SINGLE_PLACEHOLDER.exec(value);
    if (single) return lookup(scope, single[1]);
    return value.replace(PLACEHOLDER, (_match, path: string) => stringify(lookup(scope, path)));
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, scope)]));
  }
  return value;
}
