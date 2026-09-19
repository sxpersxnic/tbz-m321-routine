/**
 * Action types a routine may use. The routine service only knows the public
 * contract of each type (name + required params) – not which service
 * executes it. Commands are routed by type (`action.<type>`) via the broker.
 */
export interface ActionTypeInfo {
  type: string;
  description: string;
  /** `engine` = a scripting action the routine service evaluates itself; `worker` = sent through the broker. */
  runsIn: 'engine' | 'worker';
  requiredParams: string[];
  example: Record<string, unknown>;
}

export const ACTION_TYPES: readonly ActionTypeInfo[] = [
  {
    type: 'weather.get',
    description: 'Get the current weather from an external service',
    runsIn: 'worker',
    requiredParams: ['city'],
    example: { city: 'Zurich' },
  },
  {
    type: 'http.request',
    description: 'Send an HTTP request to an external service or webhook',
    runsIn: 'worker',
    requiredParams: ['url'],
    example: { method: 'POST', url: 'http://mock-external:8090/webhooks/demo', body: { hello: 'world' } },
  },
  {
    type: 'summary.generate',
    description: 'Build a summary from the results of earlier actions',
    runsIn: 'worker',
    requiredParams: ['title'],
    example: { title: 'Weekly Review', sections: { Weather: '{{actions.weather.summary}}' } },
  },
  {
    type: 'task.create',
    description: 'Create a task in the task system (optional listId, default list otherwise)',
    runsIn: 'worker',
    requiredParams: ['title'],
    example: { title: 'Write weekly review', dueInDays: 2, priority: 'high' },
  },
  {
    type: 'notification.send',
    description: 'Send a notification to the user',
    runsIn: 'worker',
    requiredParams: ['title'],
    example: { title: 'Good morning', body: '{{actions.weather.summary}}' },
  },
  {
    type: 'email.send',
    description: 'Send an e-mail (through the mail provider)',
    runsIn: 'worker',
    requiredParams: ['to', 'subject'],
    example: { to: 'me@example.com', subject: 'Weekly review', body: '{{actions.summary.text}}' },
  },
  {
    type: 'variable.set',
    description: 'Store a value under a name, readable later as {{vars.<name>}}',
    runsIn: 'engine',
    requiredParams: ['name'],
    example: { name: 'city', value: 'Bern' },
  },
  {
    type: 'condition.if',
    description: 'Compare two values; later steps can run only if the result is true (or false)',
    runsIn: 'engine',
    requiredParams: ['operator'],
    example: { left: '{{actions.weather.temperatureC}}', operator: 'greaterThan', right: 20 },
  },
  {
    type: 'math.calculate',
    description: 'Calculate with two numbers (+ - * / % min max round)',
    runsIn: 'engine',
    requiredParams: ['a', 'operator'],
    example: { a: '{{actions.weather.temperatureC}}', operator: '*', b: 1.8 },
  },
];

export const KNOWN_ACTION_TYPES = new Map(ACTION_TYPES.map((info) => [info.type, info]));
