import type { DomainManifest } from '@routine/service-kit';

/**
 * The `notifications` domain (docs/v2/services/notification-service.md §5): the in-app inbox. v1 (M2):
 * `notification.send`; v2 (M3): the "Ask me" human step `notification.ask` and `notification.answered`.
 */
export const NOTIFICATIONS_MANIFEST: DomainManifest = {
  contract: 1,
  domain: 'notifications',
  manifestVersion: 2,
  service: 'notification-service',
  name: 'Notifications',
  description: 'Messages to you in the app.',
  icon: 'bell',
  tint: 'pink',
  order: 20,
  optional: false,
  prefixes: ['notification'],
  page: '/notifications',
  capabilities: [
    {
      type: 'notification.send',
      kind: 'action',
      label: 'Send notification',
      sentence: 'Send notification {title}',
      description: 'Sends you a notification in the app.',
      params: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'body', label: 'Message', type: 'longText' },
        {
          name: 'priority',
          label: 'Priority',
          type: 'choice',
          options: [
            { value: 'low', label: 'Low' },
            { value: 'normal', label: 'Normal' },
            { value: 'high', label: 'High' },
          ],
          default: 'normal',
        },
      ],
      output: [
        { name: 'notificationId', label: 'Notification', type: 'text' },
        { name: 'deliveredAt', label: 'Delivered at', type: 'text' },
      ],
      sideEffects: true,
      since: 1,
    },
    {
      type: 'notification.ask',
      kind: 'human',
      label: 'Ask me',
      sentence: 'Ask me {question}',
      description: 'Asks you a question with a few answers and waits for yours.',
      icon: 'person',
      params: [
        { name: 'question', label: 'Question', type: 'text', required: true, placeholder: 'How did you sleep?' },
        { name: 'options', label: 'Answers', type: 'list', required: true, hint: '2 to 4 answers, e.g. ["Well", "Badly"]', default: ['Yes', 'No'] },
        { name: 'body', label: 'Details', type: 'longText', advanced: true },
      ],
      output: [
        { name: 'value', label: 'Answer', type: 'text', example: 'Well' },
        { name: 'label', label: 'Answer label', type: 'text', example: 'Well' },
        { name: 'answeredAt', label: 'Answered at', type: 'text' },
      ],
      sideEffects: true,
      human: { awaits: 'question' },
      since: 2,
    },
  ],
  triggers: [
    {
      type: 'notification.answered',
      label: 'A question is answered',
      sentence: 'When you answer {filter}',
      description: 'Runs when you answer a question a routine asked.',
      fields: [
        { name: 'notificationId', label: 'Question', type: 'text' },
        { name: 'value', label: 'Answer', type: 'text', example: 'Well' },
        { name: 'label', label: 'Answer label', type: 'text' },
      ],
      since: 2,
    },
  ],
};
