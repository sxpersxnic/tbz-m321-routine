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
    description: 'Get the current weather from an external service',
    requiredParams: ['city'],
    example: { city: 'Zurich' },
  },
  {
    type: 'http.request',
    description: 'Send an HTTP request to an external service or webhook',
    requiredParams: ['url'],
    example: { method: 'POST', url: 'http://mock-external:8090/webhooks/demo', body: { hello: 'world' } },
  },
  {
    type: 'summary.generate',
    description: 'Build a summary from the results of earlier actions',
    requiredParams: ['title'],
    example: { title: 'Weekly Review', sections: { Weather: '{{actions.weather.summary}}' } },
  },
  {
    type: 'task.create',
    description: 'Create a task in the task system (optional listId, default list otherwise)',
    requiredParams: ['title'],
    example: { title: 'Write weekly review', dueInDays: 2, priority: 'high' },
  },
  {
    type: 'notification.send',
    description: 'Send a notification to the user',
    requiredParams: ['title'],
    example: { title: 'Good morning', body: '{{actions.weather.summary}}' },
  },
];

export const KNOWN_ACTION_TYPES = new Map(ACTION_TYPES.map((info) => [info.type, info]));
