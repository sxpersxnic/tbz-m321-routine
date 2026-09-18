import type { RoutineInput } from './types.ts';

export interface Template {
  id: string;
  label: string;
  /** Short technical note, shown in the editor's template picker. */
  hint: string;
  /**
   * 'starter' does something a person would actually want; 'demo' exists to make
   * one distributed-systems behaviour visible. The gallery keeps them apart so a
   * first-time user is not asked to care about dead letter queues yet.
   */
  kind: 'starter' | 'demo';
  /** Plain-language "what will happen if I press this". */
  does: string;
  /** What the user can go and look at afterwards. */
  outcome: string;
  /** The concept it demonstrates – the reason each template exists. */
  teaches: string;
  routine: RoutineInput;
}

/** Starting points for the editor – each one showcases a feature of the platform. */
export const TEMPLATES: Template[] = [
  {
    id: 'weekly-review',
    kind: 'starter',
    does: 'Weather and a task, summed up in one notification.',
    outcome: '1 task and 1 notification',
    teaches: 'Parallel steps and passing results along',
    label: 'Weekly Review',
    hint: 'Mondays · weather, task, summary',
    routine: {
      name: 'Weekly Review',
      description: 'Weather and a task, summed up',
      trigger: { type: 'schedule', cron: '0 8 * * 1', timezone: 'Europe/Zurich' },
      actions: [
        { key: 'weather', type: 'weather.get', step: 1, params: { city: 'Zurich' } },
        { key: 'task', type: 'task.create', step: 1, params: { title: 'Write weekly review', dueInDays: 2, priority: 'high' } },
        {
          key: 'summary',
          type: 'summary.generate',
          step: 2,
          params: { title: 'Weekly Review', sections: { Weather: '{{actions.weather.summary}}', Task: '{{actions.task.title}} (due {{actions.task.dueDate}})' } },
        },
        { key: 'notify', type: 'notification.send', step: 3, params: { title: 'Weekly review ready', body: '{{actions.summary.text}}' } },
      ],
    },
  },
  {
    id: 'morning-setup',
    kind: 'starter',
    does: 'Weather, a daily task and a good-morning note.',
    outcome: '1 task and 1 notification every weekday morning',
    teaches: 'A schedule that runs on its own',
    label: 'Morning Setup',
    hint: 'Weekdays 07:30 · weather and daily task',
    routine: {
      name: 'Morning Setup',
      description: 'Weather, a daily plan and a note to start the day',
      trigger: { type: 'schedule', cron: '30 7 * * 1-5', timezone: 'Europe/Zurich' },
      actions: [
        { key: 'weather', type: 'weather.get', step: 1, params: { city: 'Bern' } },
        { key: 'task', type: 'task.create', step: 2, params: { title: 'Plan the day ({{actions.weather.condition}})', dueInDays: 0 } },
        { key: 'notify', type: 'notification.send', step: 3, params: { title: 'Good morning', body: '{{actions.weather.summary}}' } },
      ],
    },
  },
  {
    id: 'webhook-inbox',
    kind: 'demo',
    does: 'Turns every call to its URL into a notification.',
    outcome: 'A run for each webhook call',
    teaches: 'An external event starts a routine',
    label: 'Webhook Inbox',
    hint: 'Demo · started by a webhook call',
    routine: {
      name: 'Webhook Inbox',
      description: 'Any system can start this routine by POSTing JSON to its URL',
      trigger: { type: 'webhook' },
      actions: [
        { key: 'notify', type: 'notification.send', step: 1, params: { title: 'Webhook received', body: '{{trigger.body}}' } },
      ],
    },
  },
  {
    id: 'flaky',
    kind: 'demo',
    does: 'A webhook that only answers on the third attempt.',
    outcome: 'A run that succeeds on the third attempt',
    teaches: 'Retry with backoff: succeeds on attempt 3',
    label: 'Flaky Webhook',
    hint: 'Demo · succeeds on attempt 3',
    routine: {
      name: 'Flaky Webhook',
      description: 'The external service answers the first two attempts with 503',
      trigger: { type: 'manual' },
      actions: [
        { key: 'call', type: 'http.request', step: 1, params: { method: 'POST', url: 'http://mock-external:8090/flaky?failTimes=2', body: { ping: true } } },
        { key: 'notify', type: 'notification.send', step: 2, params: { title: 'Webhook succeeded after {{actions.call.body.attempt}} attempts' } },
      ],
    },
  },
  {
    id: 'heartbeat',
    kind: 'demo',
    does: 'Starts by itself every 30 seconds.',
    outcome: 'A new run every 30 seconds',
    teaches: 'The scheduler starts runs without a click',
    label: 'Heartbeat',
    hint: 'Demo · starts every 30 seconds',
    routine: {
      name: 'Heartbeat',
      description: 'Gets the weather every 30 seconds',
      trigger: { type: 'schedule', cron: '*/30 * * * * *', timezone: 'Europe/Zurich' },
      actions: [{ key: 'weather', type: 'weather.get', step: 1, params: { city: 'Lugano' } }],
    },
  },
  {
    id: 'load',
    kind: 'demo',
    does: 'Twelve weather lookups at once.',
    outcome: 'One run with 12 parallel actions',
    teaches: '12 actions spread across all workers',
    label: 'Load Test',
    hint: 'Demo · 12 actions at once',
    routine: {
      name: 'Load Test',
      description: '12 parallel weather lookups spread across all worker replicas',
      trigger: { type: 'manual' },
      actions: ['Zurich', 'Bern', 'Basel', 'Lucerne', 'Chur', 'Lugano', 'Geneva', 'Lausanne', 'Sion', 'Thun', 'Aarau', 'Zug'].map((city, index) => ({
        key: `w${index + 1}`,
        type: 'weather.get',
        step: 1,
        params: { city },
      })),
    },
  },
  {
    id: 'broken',
    kind: 'demo',
    does: 'Calls a URL that does not exist.',
    outcome: 'A failed run with a skipped follow-up action',
    teaches: 'A permanent error: no retry, next step skipped',
    label: 'Broken Endpoint',
    hint: 'Demo · a permanent error',
    routine: {
      name: 'Broken Endpoint',
      description: 'A 404 is permanent – no retry, the follow-up action is skipped',
      trigger: { type: 'manual' },
      actions: [
        { key: 'call', type: 'http.request', step: 1, params: { method: 'GET', url: 'http://mock-external:8090/status/404' } },
        { key: 'notify', type: 'notification.send', step: 2, params: { title: 'never sent' } },
      ],
    },
  },
];
