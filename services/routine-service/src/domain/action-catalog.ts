/**
 * Action types a routine may use. The routine service only knows the public
 * contract of each type (name + required params) – not which service
 * executes it. Commands are routed by type (`action.<type>`) via the broker.
 */
export interface ActionTypeInfo {
  type: string;
  description: string;
  requiredParams: string[];
  example: Record<string, unknown>;
}

export const ACTION_TYPES: readonly ActionTypeInfo[] = [
  {
    type: 'weather.get',
    description: 'Aktuelles Wetter bei einem externen Dienst abrufen',
    requiredParams: ['city'],
    example: { city: 'Zürich' },
  },
  {
    type: 'http.request',
    description: 'HTTP-Anfrage an einen externen Dienst oder Webhook senden',
    requiredParams: ['url'],
    example: { method: 'POST', url: 'http://mock-external:8090/webhooks/demo', body: { hello: 'world' } },
  },
  {
    type: 'summary.generate',
    description: 'Zusammenfassung aus Ergebnissen früherer Aktionen erzeugen',
    requiredParams: ['title'],
    example: { title: 'Weekly Review', sections: { Wetter: '{{actions.weather.summary}}' } },
  },
  {
    type: 'task.create',
    description: 'Aufgabe im Task-System erstellen',
    requiredParams: ['title'],
    example: { title: 'Wochenrückblick schreiben', dueInDays: 2, priority: 'high' },
  },
  {
    type: 'notification.send',
    description: 'Benachrichtigung an den Benutzer senden',
    requiredParams: ['title'],
    example: { title: 'Guten Morgen', body: '{{actions.weather.summary}}' },
  },
];

export const KNOWN_ACTION_TYPES = new Map(ACTION_TYPES.map((info) => [info.type, info]));
