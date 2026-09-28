import type { DomainManifest } from '@routine/service-kit';

/**
 * The `notifications` domain (docs/v2/services/notification-service.md §5): the in-app inbox. M2:
 * `notification.send`; the "Ask me" human step `notification.ask` and its trigger come with M3.
 */
export const NOTIFICATIONS_MANIFEST: DomainManifest = {
  contract: 1,
  domain: 'notifications',
  manifestVersion: 1,
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
  ],
};
