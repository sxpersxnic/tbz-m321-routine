// Form description per action type. The API catalog (GET /action-types) tells
// which types exist; this file decides how they look and how their params are
// edited. Unknown types fall back to a raw JSON editor and a neutral look.

/** `tasklist` = a select filled with the user's task lists. */
export type FieldKind = 'text' | 'textarea' | 'number' | 'select' | 'json' | 'keyvalue' | 'tasklist';

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
}

const PRIORITY: Pick<ParamField, 'options' | 'optionLabels'> = {
  options: ['low', 'normal', 'high'],
  optionLabels: { low: 'Low', normal: 'Normal', high: 'High' },
};

export const ACTION_FORMS: Record<string, ActionForm> = {
  'weather.get': {
    label: 'Get weather',
    blurb: 'Fetches the current weather for a city.',
    glyph: 'cloud',
    tint: 'sky',
    fields: [{ name: 'city', label: 'City', kind: 'text', required: true, placeholder: 'Zurich' }],
    outputs: { summary: 'Forecast', temperatureC: 'Temperature', condition: 'Conditions' },
    defaults: { city: 'Zurich' },
  },
  'http.request': {
    label: 'Call webhook',
    blurb: 'Sends a request to another service.',
    glyph: 'globe',
    tint: 'violet',
    fields: [
      { name: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'url', label: 'URL', kind: 'text', required: true, placeholder: 'http://mock-external:8090/webhooks/demo', hint: 'mock-external only' },
      { name: 'body', label: 'Body (JSON)', kind: 'json', placeholder: '{ "hello": "world" }' },
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
  'task.create': {
    label: 'Create task',
    blurb: 'Puts a task on your list.',
    glyph: 'checklist',
    tint: 'green',
    fields: [
      { name: 'title', label: 'Title', kind: 'text', required: true },
      { name: 'description', label: 'Notes', kind: 'textarea' },
      { name: 'priority', label: 'Priority', kind: 'select', ...PRIORITY },
      { name: 'dueInDays', label: 'Due in days', kind: 'number', hint: '0 = today' },
      { name: 'listId', label: 'List', kind: 'tasklist' },
    ],
    outputs: { title: 'Task', dueDate: 'Due date' },
    defaults: { title: 'New task', priority: 'normal' },
  },
  'notification.send': {
    label: 'Send notification',
    blurb: 'Sends you a notification in the app.',
    glyph: 'bell',
    tint: 'pink',
    fields: [
      { name: 'title', label: 'Title', kind: 'text', required: true },
      { name: 'body', label: 'Message', kind: 'textarea' },
      { name: 'priority', label: 'Priority', kind: 'select', ...PRIORITY },
    ],
    outputs: {},
    defaults: { title: 'Routine finished', body: '' },
  },
};

export const GLOBAL_REFERENCES: Record<string, string> = {
  '{{routine.name}}': 'Routine name',
  '{{now}}': 'Date & time',
};

/** Offered only in webhook routines – elsewhere the call body does not exist. */
export const WEBHOOK_REFERENCES: Record<string, string> = {
  '{{trigger.body}}': 'Webhook data',
};

export const actionLabel = (type: string): string => ACTION_FORMS[type]?.label ?? type;
export const actionGlyph = (type: string): string => ACTION_FORMS[type]?.glyph ?? 'bolt';
export const actionTint = (type: string): Tint => ACTION_FORMS[type]?.tint ?? 'grey';

/** One-word names, for places that show the shape of a routine rather than its detail. */
const SHORT: Record<string, string> = {
  'weather.get': 'Weather',
  'http.request': 'Webhook',
  'summary.generate': 'Summary',
  'task.create': 'Task',
  'notification.send': 'Notification',
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
      const due = dueWords(params.dueInDays);
      return [
        'Create task ', tok(str(params.title) || 'untitled'),
        ...(due ? [', due ', tok(due)] : []),
        ...(params.priority === 'high' ? [' · important'] : []),
      ];
    }
    case 'notification.send':
      return ['Send notification ', tok(str(params.title) || 'untitled')];
    default:
      return [actionLabel(type)];
  }
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
  const body = /^\{\{trigger\.body\.([^}]+)\}\}$/.exec(reference);
  if (body) return `Webhook › ${body[1].split('.').join(' › ')}`;
  const match = /^\{\{actions\.([^.}]+)\.([^}]+)\}\}$/.exec(reference);
  if (!match) return reference.slice(2, -2);
  const [, key, field] = match;
  const type = types[key];
  const [head, ...rest] = field.split('.');
  const fieldName = (type && ACTION_FORMS[type]?.outputs[head]) ?? head;
  const source = type ? actionShort(type) : key;
  return `${fieldName}${rest.length ? ` › ${rest.join(' › ')}` : ''}${withSource ? ` (${source})` : ''}`;
}
