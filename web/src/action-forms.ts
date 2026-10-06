// How steps look and how their params are edited. Every step's form is generated from its manifest
// (forms/generate.ts, docs/v2/07-web.md §5); this file keeps only the hand-made overrides – where a
// form made by hand is better – and the helpers everyone uses. Resolution: override → generated →
// nothing (a raw JSON editor and a neutral look, as for unknown types).

/**
 * `tasklist` = a select filled with the user's task lists.
 * `value` = free text that becomes a number, list or object when it reads as JSON (`42`, `["a","b"]`).
 * `routine` = a select of the user's routines; stores `routineId` and, for display, `routineName`.
 * `duration` = a select of common ISO 8601 durations (forms/durations.ts).
 */
export type FieldKind = 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'time' | 'select' | 'json' | 'keyvalue' | 'tasklist' | 'value' | 'routine' | 'duration';

export interface ParamField {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: string[];
  /** Words for select values – the API speaks `high`, people say "High". */
  optionLabels?: Record<string, string>;
  placeholder?: string;
  hint?: string;
  /** Lower bound of a number field. */
  min?: number;
  /** Whole numbers only. */
  integer?: boolean;
  /** Shown under "More options". */
  advanced?: boolean;
}

/** The colour family of an action. Colour is a second cue only – the label always says it too. */
export type Tint = 'sky' | 'indigo' | 'violet' | 'pink' | 'orange' | 'green' | 'teal' | 'grey';

export interface ActionForm {
  label: string;
  /** One sentence for the "add action" palette: what this does for *you*. */
  blurb: string;
  /** Icon name from components/ui.tsx. */
  glyph: string;
  tint: Tint;
  fields: ParamField[];
  /** Output fields other actions can reference via {{actions.<key>.<field>}}, with their names in words. */
  outputs: Record<string, string>;
  defaults: Record<string, unknown>;
  /** Shortcuts' "Scripting" group: evaluated by the routine engine, no service call. */
  scripting?: boolean;
  /** The manifest's sentence, `{param}` placeholders – how a generated step reads. */
  sentence?: string;
}

const CONDITION: Pick<ParamField, 'options' | 'optionLabels'> = {
  options: ['equals', 'notEquals', 'contains', 'notContains', 'greaterThan', 'lessThan', 'isEmpty', 'isNotEmpty'],
  optionLabels: {
    equals: 'is', notEquals: 'is not', contains: 'contains', notContains: 'does not contain',
    greaterThan: 'is greater than', lessThan: 'is less than', isEmpty: 'is empty', isNotEmpty: 'is not empty',
  },
};

const MATH: Pick<ParamField, 'options' | 'optionLabels'> = {
  options: ['+', '-', '*', '/', '%', 'min', 'max', 'round'],
  optionLabels: { '+': '+', '-': '−', '*': '×', '/': '÷', '%': 'modulo', min: 'min', max: 'max', round: 'round to digits' },
};

/** Hand-made forms that beat the generated ones (07 §5.3). */
const OVERRIDES: Record<string, ActionForm> = {
  'http.request': {
    label: 'Call webhook',
    blurb: 'Sends a request to another service.',
    glyph: 'globe',
    tint: 'violet',
    fields: [
      { name: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'url', label: 'URL', kind: 'text', required: true, placeholder: 'http://mock-external:8090/webhooks/demo', hint: 'mock-external only' },
      { name: 'body', label: 'Body (JSON)', kind: 'json', placeholder: '{ "hello": "world" }' },
      { name: 'headers', label: 'Headers', kind: 'keyvalue', advanced: true },
    ],
    outputs: { status: 'HTTP status', body: 'Response' },
    defaults: { method: 'POST', url: 'http://mock-external:8090/webhooks/demo', body: { routine: '{{routine.name}}' } },
  },
  'summary.generate': {
    label: 'Create summary',
    blurb: 'Combines results of earlier steps into one text.',
    glyph: 'doc',
    tint: 'orange',
    fields: [
      { name: 'title', label: 'Title', kind: 'text', required: true },
      { name: 'sections', label: 'Sections', kind: 'keyvalue' },
    ],
    outputs: { text: 'Text', title: 'Title' },
    defaults: { title: 'Summary', sections: {} },
  },
  'condition.if': {
    label: 'If',
    blurb: 'Compares two values – later steps can run only if it holds.',
    glyph: 'branch',
    tint: 'grey',
    scripting: true,
    fields: [
      { name: 'left', label: 'Value', kind: 'value' },
      { name: 'operator', label: 'Comparison', kind: 'select', required: true, ...CONDITION },
      { name: 'right', label: 'Compared with', kind: 'value' },
    ],
    outputs: { result: 'Result' },
    defaults: { left: '', operator: 'equals', right: '' },
  },
  'routine.run': {
    label: 'Run routine',
    blurb: 'Runs another routine like a function and waits for it.',
    glyph: 'routines',
    tint: 'grey',
    scripting: true,
    fields: [
      { name: 'routineId', label: 'Routine', kind: 'routine', required: true },
      { name: 'input', label: 'Input', kind: 'value', hint: 'The routine reads it as {{input}}; it returns its variable "result"' },
    ],
    outputs: { result: 'Result' },
    defaults: {},
  },
};

/** What a "repeat for each" step offers to later steps. */
export const LOOP_OUTPUTS: Record<string, string> = { items: 'Results', count: 'Count' };

export const GLOBAL_REFERENCES: Record<string, string> = {
  '{{routine.name}}': 'Routine name',
  '{{now}}': 'Date & time',
};

/** Offered only in webhook routines – elsewhere the call body does not exist. */
export const WEBHOOK_REFERENCES: Record<string, string> = {
  '{{trigger.body}}': 'Webhook data',
};

let generated: Record<string, ActionForm> = {};
/** Labels of the event fields (`{{trigger.event.<field>}}`), by field name – the same across events. */
let eventFieldLabels: Record<string, string> = {};

/** Called by the catalog store whenever the catalog (re)loads. */
export function setGeneratedForms(forms: Record<string, ActionForm>, eventLabels: Record<string, string> = {}): void {
  generated = forms;
  eventFieldLabels = eventLabels;
}

/** A step type's form: the hand-made override, else the one generated from its manifest. */
export const formOf = (type: string): ActionForm | undefined => OVERRIDES[type] ?? generated[type];

export const actionLabel = (type: string): string => formOf(type)?.label ?? type;
export const actionGlyph = (type: string): string => formOf(type)?.glyph ?? 'bolt';
export const actionTint = (type: string): Tint => formOf(type)?.tint ?? 'grey';

/** One-word names, for places that show the shape of a routine rather than its detail. */
const SHORT: Record<string, string> = {
  'weather.get': 'Weather',
  'http.request': 'Webhook',
  'summary.generate': 'Summary',
  'task.create': 'Task',
  'notification.send': 'Notification',
  'email.send': 'E-mail',
  'variable.set': 'Variable',
  'condition.if': 'If',
  'math.calculate': 'Calculation',
  'routine.run': 'Routine',
};

export const actionShort = (type: string): string => SHORT[type] ?? actionLabel(type);

// ---------------------------------------------------------------- sentences
//
// Shortcuts-style: an action reads as what it does, with the values that make it
// *this* action set apart as tokens – "Get weather for [Bern]" says more than a
// label plus a form ever does.

export type SentencePart = string | { token: string };

const tok = (value: unknown): SentencePart => ({ token: String(value) });
const str = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

function dueWords(days: unknown): string | null {
  if (days === undefined || days === null || days === '') return null;
  const n = Number(days);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

/** A value as a token: text as is, lists and numbers as JSON, nothing as "…". */
function valueWords(value: unknown): string {
  if (value === undefined || value === null || value === '') return '…';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** "http://mock-external:8090/flaky?failTimes=2" → "mock-external/flaky" */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return url;
  }
}

export function actionSentence(type: string, params: Record<string, unknown>): SentencePart[] {
  switch (type) {
    case 'weather.get':
      return ['Get weather for ', tok(str(params.city) || 'a city')];
    case 'http.request':
      return ['Call webhook ', tok(shortUrl(str(params.url)) || 'without URL')];
    case 'summary.generate': {
      const sections = Object.keys((params.sections as Record<string, unknown>) ?? {}).length;
      return ['Create summary ', tok(str(params.title) || 'untitled'), ...(sections > 1 ? [` · ${sections} sections`] : [])];
    }
    case 'task.create': {
      // v1 routines say dueInDays, the M2 form a date
      const due = dueWords(params.dueInDays) ?? (typeof params.dueDate === 'string' && params.dueDate ? dateWords(params.dueDate) : null);
      return [
        'Create task ', tok(str(params.title) || 'untitled'),
        ...(due ? [', due ', tok(due)] : []),
        ...(params.priority === 'high' ? [' · important'] : []),
      ];
    }
    case 'notification.send':
      return ['Send notification ', tok(str(params.title) || 'untitled')];
    case 'email.send':
      return ['Send e-mail ', tok(str(params.subject) || 'untitled'), ' to ', tok(str(params.to) || 'nobody yet')];
    case 'variable.set':
      return ['Set ', tok(str(params.name) || 'variable'), ' to ', tok(valueWords(params.value))];
    case 'condition.if': {
      const operator = str(params.operator);
      const unary = operator === 'isEmpty' || operator === 'isNotEmpty';
      return ['If ', tok(valueWords(params.left)), ` ${CONDITION.optionLabels?.[operator] ?? operator}`, ...(unary ? [] : [' ', tok(valueWords(params.right))])];
    }
    case 'routine.run':
      return ['Run routine ', tok(str(params.routineName) || 'not chosen'), ...(params.input !== undefined && params.input !== '' ? [' with ', tok(valueWords(params.input))] : [])];
    case 'math.calculate': {
      const operator = str(params.operator);
      return ['Calculate ', tok(valueWords(params.a)), ` ${MATH.optionLabels?.[operator] ?? operator} `, tok(valueWords(params.b))];
    }
    default:
      return templateSentence(type, params);
  }
}

/** Relative dates in words: `+0d` today, `+1d` tomorrow, `+3d` in 3 days. */
function dateWords(value: string): string {
  const relative = /^\+(\d+)d$/.exec(value);
  return relative ? (dueWords(Number(relative[1])) ?? value) : value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A param's value in words: a choice's label, "tomorrow" for +1d, yes/no; a picked id by what it is. */
function paramWords(field: ParamField | undefined, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value !== 'string') return valueWords(value);
  if (field?.optionLabels) return field.optionLabels[value] ?? value;
  // names need the collection; the pickers show them, the sentence says what was picked
  if (UUID.test(value)) return field?.label.toLowerCase() ?? value;
  return field?.kind === 'date' ? dateWords(value) : value;
}

/**
 * A generated step's sentence (07 §5.2): the manifest's sentence with every `{param}` as a token of its
 * value in words. An empty required param shows its name; an empty optional one is left out together
 * with the words leading to it (back to a comma, else one word) – "Create task [Pay rent], due [tomorrow]"
 * reads "Create task [Pay rent]" without a date.
 */
function templateSentence(type: string, params: Record<string, unknown>): SentencePart[] {
  const form = formOf(type);
  if (!form?.sentence) return [actionLabel(type)];
  const parts: SentencePart[] = [];
  let last = 0;
  for (const match of form.sentence.matchAll(/\{([a-zA-Z0-9]+)\}/g)) {
    let before = form.sentence.slice(last, match.index);
    last = match.index + match[0].length;
    const field = form.fields.find((candidate) => candidate.name === match[1]);
    const value = params[match[1]];
    const empty = value === undefined || value === null || value === '';
    if (empty && !field?.required) {
      const comma = before.lastIndexOf(', ');
      before = comma >= 0 ? before.slice(0, comma) : before.replace(/\s*\S+\s*$/, '');
      if (before) parts.push(before);
      continue;
    }
    if (before) parts.push(before);
    parts.push(tok(empty ? (field?.label ?? match[1]).toLowerCase() : paramWords(field, value)));
  }
  if (last < form.sentence.length) parts.push(form.sentence.slice(last));
  return parts;
}

/**
 * A sentence as plain text with references named ("Temperature is greater than 20")
 * – for a select option or a tag that points at another step.
 */
export function sentencePlain(type: string, params: Record<string, unknown>, types: Record<string, string>): string {
  return actionSentence(type, params)
    .map((part) => (typeof part === 'string' ? part : part.token.replace(/\{\{[^}]+\}\}/g, (reference) => describeReference(reference, types, false))))
    .join('');
}

/** How a step that depends on an If reads: "If …" when it needs true, "Otherwise – …" when it needs false. */
export function conditionWords(condition: { type: string; params: Record<string, unknown> }, is: boolean, types: Record<string, string>): string {
  const text = sentencePlain(condition.type, condition.params, types).replace(/^If /, '');
  return is ? `If ${text}` : `Otherwise – ${text}`;
}

/** The action type a reference comes from, so a pill can show its glyph instead of "(Weather)". */
export function referenceSource(reference: string, types: Record<string, string>): string | undefined {
  const match = /^\{\{actions\.([^.}]+)\./.exec(reference);
  return match ? types[match[1]] : undefined;
}

/**
 * `{{actions.weather.condition}}` → "Conditions (Weather)". `types` maps the
 * action keys of this routine to their type, so the output name can be looked up.
 */
export function describeReference(reference: string, types: Record<string, string>, withSource = true): string {
  if (GLOBAL_REFERENCES[reference]) return GLOBAL_REFERENCES[reference];
  if (WEBHOOK_REFERENCES[reference]) return WEBHOOK_REFERENCES[reference];
  if (reference === '{{trigger.type}}') return 'Trigger';
  if (reference === '{{item}}') return 'Item';
  if (reference === '{{input}}') return 'Input';
  if (reference === '{{index}}') return 'Index';
  const item = /^\{\{item\.([^}]+)\}\}$/.exec(reference);
  if (item) return `Item › ${item[1].split('.').join(' › ')}`;
  const variable = /^\{\{vars\.([^}]+)\}\}$/.exec(reference);
  if (variable) return variable[1].split('.').join(' › ');
  const body = /^\{\{trigger\.body\.([^}]+)\}\}$/.exec(reference);
  if (body) return `Webhook › ${body[1].split('.').join(' › ')}`;
  const event = /^\{\{trigger\.event\.([^}]+)\}\}$/.exec(reference);
  if (event) return `Event › ${eventFieldLabels[event[1]] ?? event[1]}`;
  const match = /^\{\{actions\.([^.}]+)\.([^}]+)\}\}$/.exec(reference);
  if (!match) return reference.slice(2, -2);
  const [, key, field] = match;
  const type = types[key];
  const [head, ...rest] = field.split('.');
  const fieldName = (type && formOf(type)?.outputs[head]) ?? LOOP_OUTPUTS[head] ?? head;
  const source = type ? actionShort(type) : key;
  return `${fieldName}${rest.length ? ` › ${rest.join(' › ')}` : ''}${withSource ? ` (${source})` : ''}`;
}
