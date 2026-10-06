import type { RoutineInput } from './types.ts';

/**
 * Routines that exist to make one behaviour of the distributed system visible. They live on
 * the Infrastructure page, next to the topology they animate – not in the template gallery,
 * where a first-time user would be asked to care about dead letter queues.
 */
export interface DemoScenario {
  id: string;
  label: string;
  /** What it makes visible, as a label: "Retries with backoff". */
  demonstrates: string;
  routine: RoutineInput;
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'flaky',
    label: 'Flaky Webhook',
    demonstrates: 'Retries with backoff',
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
    id: 'load',
    label: 'Load Test',
    demonstrates: 'Horizontal scaling',
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
    label: 'Broken Endpoint',
    demonstrates: 'Permanent failure, no retry',
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
  {
    id: 'heartbeat',
    label: 'Heartbeat',
    demonstrates: 'Scheduler',
    routine: {
      name: 'Heartbeat',
      description: 'Gets the weather every 30 seconds',
      trigger: { type: 'schedule', cron: '*/30 * * * * *', timezone: 'Europe/Zurich' },
      actions: [{ key: 'weather', type: 'weather.get', step: 1, params: { city: 'Lugano' } }],
    },
  },
];
