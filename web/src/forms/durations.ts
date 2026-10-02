/** Durations people pick (ISO 8601) – for `duration` params and "If you don't get to it". */
export const DURATION_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'PT5M', label: '5 minutes' },
  { value: 'PT15M', label: '15 minutes' },
  { value: 'PT30M', label: '30 minutes' },
  { value: 'PT1H', label: '1 hour' },
  { value: 'PT2H', label: '2 hours' },
  { value: 'PT4H', label: '4 hours' },
  { value: 'PT8H', label: '8 hours' },
  { value: 'P1D', label: '1 day' },
  { value: 'P2D', label: '2 days' },
  { value: 'P1W', label: '1 week' },
];

export const DURATION_LABELS: Record<string, string> = Object.fromEntries(DURATION_CHOICES.map((choice) => [choice.value, choice.label]));
