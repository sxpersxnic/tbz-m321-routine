// Light/dark is a comfort and accessibility choice, not only an OS setting:
// a beamer in a bright room or a late-night session wants the opposite of what
// the machine reports. "system" stays the default and follows the OS.

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'routine.theme';
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Sets (or clears) the attribute the stylesheet keys `color-scheme` off. */
function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

let current = read();
apply(current);

export const THEME_ORDER: Theme[] = ['system', 'light', 'dark'];

export const THEME_LABELS: Record<Theme, string> = {
  // not "System" – that is already a nav item
  system: 'Automatic',
  light: 'Light',
  dark: 'Dark',
};

export const THEME_ICONS: Record<Theme, string> = {
  system: 'contrast',
  light: 'sun',
  dark: 'moon',
};

export const themeStore = {
  get: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(next: Theme) {
    current = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage unavailable – the choice lasts for this page load only
    }
    apply(next);
    listeners.forEach((listener) => { listener(); });
  },
};
