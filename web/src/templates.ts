import type { RoutineInput } from './types.ts';

export interface Template {
  id: string;
  label: string;
  /** Short technical note, shown in the editor's template picker. */
  hint: string;
  /** Plain-language "what will happen if I press this". */
  does: string;
  /** What the user can go and look at afterwards. */
  outcome: string;
  routine: RoutineInput;
}

/** Starting points for a person's own routines. The systems demos live in demo-scenarios.ts. */
export const TEMPLATES: Template[] = [
  {
    id: 'weekly-review',
    does: 'Weather and a task, summed up in one notification.',
    outcome: '1 task and 1 notification',
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
    does: 'Weather, a daily task and a good-morning note.',
    outcome: '1 task and 1 notification every weekday morning',
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
    does: 'Turns every call to its URL into a notification.',
    outcome: 'A run for each webhook call',
    label: 'Webhook Inbox',
    hint: 'Started by a webhook call',
    routine: {
      name: 'Webhook Inbox',
      description: 'Any system can start this routine by POSTing JSON to its URL',
      trigger: { type: 'webhook' },
      actions: [
        { key: 'notify', type: 'notification.send', step: 1, params: { title: 'Webhook received', body: '{{trigger.body}}' } },
      ],
    },
  },
];
