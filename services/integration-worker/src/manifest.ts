import type { DomainManifest } from '@routine/service-kit';

/**
 * The `connections` domain (docs/v2/services/integration-worker.md §5): calls to the outside world.
 * M2: the v1 steps. `weather.get` and `summary.generate` only read or compute (values, safe in test
 * runs); `email.send` can answer a test run with a preview (M2-07). chat.post and feed.latest come
 * with M9, secrets in http.request headers too.
 */
export const CONNECTIONS_MANIFEST: DomainManifest = {
  contract: 1,
  domain: 'connections',
  manifestVersion: 1,
  service: 'integration-worker',
  name: 'Connections',
  description: 'Weather, websites and e-mail – Routine talking to the outside world.',
  icon: 'globe',
  tint: 'violet',
  order: 30,
  optional: false,
  prefixes: ['weather', 'http', 'summary', 'email'],
  capabilities: [
    {
      type: 'weather.get',
      kind: 'value',
      label: 'Get weather',
      sentence: 'Get weather for {city}',
      description: 'Fetches the current weather for a city.',
      icon: 'cloud',
      tint: 'sky',
      params: [{ name: 'city', label: 'City', type: 'text', required: true, placeholder: 'Zurich' }],
      output: [
        { name: 'city', label: 'City', type: 'text' },
        { name: 'temperatureC', label: 'Temperature', type: 'number', example: 21 },
        { name: 'condition', label: 'Conditions', type: 'text', example: 'sunny' },
        { name: 'summary', label: 'Forecast', type: 'text', example: 'Zurich: sunny, 21 °C' },
      ],
      sideEffects: false,
      since: 1,
    },
    {
      type: 'http.request',
      kind: 'action',
      label: 'Call webhook',
      sentence: 'Call webhook {url}',
      description: 'Sends a request to another service.',
      params: [
        {
          name: 'method',
          label: 'Method',
          type: 'choice',
          options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => ({ value: method, label: method })),
          default: 'GET',
          templating: false,
        },
        { name: 'url', label: 'URL', type: 'text', required: true, placeholder: 'http://mock-external:8090/webhooks/demo', hint: 'mock-external only' },
        { name: 'headers', label: 'Headers', type: 'object', advanced: true },
        { name: 'body', label: 'Body (JSON)', type: 'value' },
      ],
      output: [
        { name: 'status', label: 'HTTP status', type: 'integer', example: 200 },
        { name: 'body', label: 'Response', type: 'value' },
      ],
      sideEffects: true,
      since: 1,
    },
    {
      type: 'summary.generate',
      kind: 'value',
      label: 'Create summary',
      sentence: 'Create summary {title}',
      description: 'Combines results of earlier steps into one text.',
      icon: 'doc',
      tint: 'orange',
      params: [
        { name: 'title', label: 'Title', type: 'text', required: true },
        { name: 'sections', label: 'Sections', type: 'object' },
        { name: 'lines', label: 'Lines', type: 'list', advanced: true },
      ],
      output: [
        { name: 'text', label: 'Text', type: 'longText' },
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'lineCount', label: 'Lines', type: 'integer' },
      ],
      sideEffects: false,
      since: 1,
    },
    {
      type: 'email.send',
      kind: 'action',
      label: 'Send e-mail',
      sentence: 'Send e-mail {subject} to {to}',
      description: 'Sends an e-mail to one or more addresses.',
      icon: 'mail',
      tint: 'indigo',
      params: [
        { name: 'to', label: 'To', type: 'text', required: true, placeholder: 'ada@example.com', hint: 'Several: separate with commas' },
        { name: 'subject', label: 'Subject', type: 'text', required: true },
        { name: 'body', label: 'Message', type: 'longText' },
      ],
      output: [
        { name: 'messageId', label: 'Message ID', type: 'text' },
        { name: 'to', label: 'Recipients', type: 'text' },
        { name: 'subject', label: 'Subject', type: 'text' },
        { name: 'sentAt', label: 'Sent at', type: 'text' },
      ],
      sideEffects: true,
      preview: true,
      since: 1,
    },
  ],
};
