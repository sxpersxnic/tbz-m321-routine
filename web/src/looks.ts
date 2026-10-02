import type { Tint } from './action-forms.ts';

/** The palette routines and task lists choose from. */
export const COLOR_CHOICES: Array<{ tint: Tint; label: string }> = [
  { tint: 'sky', label: 'Blue' },
  { tint: 'indigo', label: 'Indigo' },
  { tint: 'violet', label: 'Purple' },
  { tint: 'pink', label: 'Pink' },
  { tint: 'orange', label: 'Orange' },
  { tint: 'green', label: 'Green' },
  { tint: 'teal', label: 'Teal' },
  { tint: 'grey', label: 'Graphite' },
];

/** The symbols routines and task lists choose from. */
export const ICON_CHOICES: Array<{ name: string; label: string }> = [
  { name: 'bolt', label: 'Bolt' },
  { name: 'sparkles', label: 'Sparkles' },
  { name: 'star', label: 'Star' },
  { name: 'heart', label: 'Heart' },
  { name: 'bell', label: 'Bell' },
  { name: 'checklist', label: 'Checklist' },
  { name: 'calendar', label: 'Calendar' },
  { name: 'clock', label: 'Clock' },
  { name: 'cloud', label: 'Cloud' },
  { name: 'sun', label: 'Sun' },
  { name: 'moon', label: 'Moon' },
  { name: 'globe', label: 'Globe' },
  { name: 'mail', label: 'Mail' },
  { name: 'inbox', label: 'Inbox' },
  { name: 'doc', label: 'Document' },
  { name: 'book', label: 'Book' },
  { name: 'flag', label: 'Flag' },
  { name: 'home', label: 'Home' },
  { name: 'briefcase', label: 'Work' },
  { name: 'coffee', label: 'Coffee' },
];
