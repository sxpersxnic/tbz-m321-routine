// Form description per action type. The API catalog (GET /action-types) tells
// which types exist; this file only decides how their params are edited.
// Unknown types fall back to a raw JSON editor.

export type FieldKind = 'text' | 'textarea' | 'number' | 'select' | 'json' | 'keyvalue';

export interface ParamField {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: string[];
  placeholder?: string;
  hint?: string;
}

export interface ActionForm {
  label: string;
  /** Short hint which part of the system executes it – purely informational. */
  icon: string;
  fields: ParamField[];
  /** Output fields other actions can reference via {{actions.<key>.<field>}}. */
  outputs: string[];
  defaults: Record<string, unknown>;
}

export const ACTION_FORMS: Record<string, ActionForm> = {
  'weather.get': {
    label: 'Wetter abrufen',
    icon: '☁',
    fields: [{ name: 'city', label: 'Stadt', kind: 'text', required: true, placeholder: 'Zürich' }],
    outputs: ['summary', 'temperatureC', 'condition', 'city'],
    defaults: { city: 'Zürich' },
  },
  'http.request': {
    label: 'HTTP-Anfrage / Webhook',
    icon: '⇄',
    fields: [
      { name: 'method', label: 'Methode', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'url', label: 'URL', kind: 'text', required: true, placeholder: 'http://mock-external:8090/webhooks/demo', hint: 'Erlaubte Hosts: mock-external' },
      { name: 'body', label: 'Body (JSON)', kind: 'json', placeholder: '{ "hello": "world" }' },
    ],
    outputs: ['status', 'body'],
    defaults: { method: 'POST', url: 'http://mock-external:8090/webhooks/demo', body: { routine: '{{routine.name}}' } },
  },
  'summary.generate': {
    label: 'Zusammenfassung erzeugen',
    icon: '≡',
    fields: [
      { name: 'title', label: 'Titel', kind: 'text', required: true },
      { name: 'sections', label: 'Abschnitte', kind: 'keyvalue', hint: 'Name → Inhalt, gerne mit Verweisen auf frühere Aktionen' },
    ],
    outputs: ['text', 'title', 'lineCount'],
    defaults: { title: 'Zusammenfassung', sections: {} },
  },
  'task.create': {
    label: 'Aufgabe erstellen',
    icon: '✓',
    fields: [
      { name: 'title', label: 'Titel', kind: 'text', required: true },
      { name: 'description', label: 'Beschreibung', kind: 'textarea' },
      { name: 'priority', label: 'Priorität', kind: 'select', options: ['low', 'normal', 'high'] },
      { name: 'dueInDays', label: 'Fällig in (Tagen)', kind: 'number' },
    ],
    outputs: ['taskId', 'title', 'dueDate', 'priority'],
    defaults: { title: 'Neue Aufgabe', priority: 'normal' },
  },
  'notification.send': {
    label: 'Benachrichtigung senden',
    icon: '✉',
    fields: [
      { name: 'title', label: 'Titel', kind: 'text', required: true },
      { name: 'body', label: 'Text', kind: 'textarea' },
      { name: 'priority', label: 'Priorität', kind: 'select', options: ['low', 'normal', 'high'] },
    ],
    outputs: ['notificationId'],
    defaults: { title: 'Routine fertig', body: '' },
  },
};

export const GLOBAL_REFERENCES = ['{{routine.name}}', '{{execution.id}}', '{{now}}'];

export function actionLabel(type: string): string {
  return ACTION_FORMS[type]?.label ?? type;
}

export function actionIcon(type: string): string {
  return ACTION_FORMS[type]?.icon ?? '•';
}
