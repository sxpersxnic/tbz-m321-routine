import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { THEME_ICONS, THEME_LABELS, THEME_ORDER, themeStore } from '../theme.ts';
import { useToast } from './toast.tsx';

// ---------------------------------------------------------------- icons (inline SVG, no dependency)

const ICONS: Record<string, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  routines: (
    <>
      <path d="M4 12a8 8 0 0 1 13.6-5.7" />
      <path d="M20 12a8 8 0 0 1-13.6 5.7" />
      <path d="M18 3v4h-4" />
      <path d="M6 21v-4h4" />
    </>
  ),
  executions: <polyline points="3 12 7 12 10 5 14 19 17 12 21 12" />,
  tasks: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <polyline points="8 12 11 15 16 9" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </>
  ),
  system: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  home: <path d="M4 11l8-7 8 7M6 9.5V20h4.5v-5h3v5H18V9.5" />,
  cloud: <path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.5 9.2 4.4 4.4 0 0 0 7 18z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
    </>
  ),
  doc: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </>
  ),
  checklist: (
    <>
      <path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17" />
      <path d="M11 6.5h9M11 12.5h9M11 18.5h9" />
    </>
  ),
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M9 5l7 7-7 7" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  sparkles: <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />,
  pause: <path d="M9 5v14M15 5v14" />,
  retry: <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />,
  inbox: <path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1.5 2.5h5L16 13h5" />,
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
  stack: <path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  link: <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  play: <polygon points="7 5 19 12 7 19" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  logout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  back: <path d="M15 5l-7 7 7 7" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
    </>
  ),
  up: <path d="M12 19V5M5 12l7-7 7 7" />,
  down: <path d="M12 5v14M5 12l7 7 7-7" />,
  warning: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.6 5.4A9.9 9.9 0 0 1 12 5c6.4 0 10 6 10 6a17 17 0 0 1-3.4 3.9M6.5 7.1A17 17 0 0 0 2 11s3.6 6 10 6a9.8 9.8 0 0 0 3.6-.7" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />,
  contrast: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

// ---------------------------------------------------------------- building blocks

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Starting',
  RUNNING: 'Running',
  WAITING: 'Waiting',
  COMPLETED: 'Succeeded',
  FAILED: 'Failed',
  DISPATCHED: 'In progress',
  RETRYING: 'Retrying',
  SKIPPED: 'Skipped',
  up: 'Online',
  down: 'Offline',
};

/** The one place a status enum becomes words – badges, pipeline and filters share it. */
export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

const BADGE_TONE: Record<string, string> = {
  COMPLETED: 'ok', up: 'ok', FAILED: 'err', down: 'err',
  RUNNING: 'busy', DISPATCHED: 'busy', PENDING: 'busy', WAITING: 'wait', RETRYING: 'wait',
};

export function StatusBadge({ status }: { status: string }) {
  const tone = BADGE_TONE[status] ?? 'idle';
  return (
    <span className={`badge tone-${tone}`}>
      {tone === 'busy' && <span className="pulse" />}
      {statusLabel(status)}
    </span>
  );
}

/** Cycles Automatic → Light → Dark; one compact control instead of a settings page. */
export function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const theme = useSyncExternalStore(themeStore.subscribe, themeStore.get);
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  return (
    <button type="button" className={`btn plain small ${withLabel ? '' : 'icon-only'}`}
      title={`Appearance: ${THEME_LABELS[theme]} – switch to ${THEME_LABELS[next]}`}
      aria-label={`Appearance: ${THEME_LABELS[theme]}. Switch to ${THEME_LABELS[next]}`}
      onClick={() => themeStore.set(next)}>
      <Icon name={THEME_ICONS[theme]} size={16} />
      {withLabel && <span>{THEME_LABELS[theme]}</span>}
    </button>
  );
}

/** An icon-only button always needs a name a screen reader can read out. */
export function IconButton({ icon, label, onClick, className = '', disabled, size = 16 }: {
  icon: string;
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  size?: number;
}) {
  return (
    <button type="button" className={`btn ghost icon-only ${className}`} title={label} aria-label={label}
      onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** An empty state should say what happened *and* offer the next step. */
export function Empty({ children, action, icon, title }: { children?: ReactNode; action?: ReactNode; icon?: string; title?: string }) {
  return (
    <div className="empty">
      {icon && <span className="empty-art" aria-hidden="true"><Icon name={icon} size={30} /></span>}
      {title && <h3>{title}</h3>}
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** A titled group on a page – the "Section header + content" rhythm of Apple's apps. */
export function Section({ title, description, action, children, id }: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** "See all ›" */
export function SeeAll({ href, children = 'See all' }: { href: string; children?: ReactNode }) {
  return <a className="see-all" href={href}>{children} <Icon name="chevron" size={14} /></a>;
}

export function Loading() {
  return <p className="empty" role="status"><span className="spinner" /><span className="sr-only">Loading</span></p>;
}

/**
 * Placeholder blocks that hold a detail page's shape while it loads, so the
 * layout does not jump and the user keeps their bearings (and the back link).
 */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => <span key={index} className="skeleton-line" />)}
    </div>
  );
}

/**
 * A failure the user can act on. Without `onRetry` a stale screen leaves them
 * reloading the browser, which is the one thing that also loses their place.
 */
export function ErrorNote({ error, onRetry }: { error: Error | undefined; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="error-note">
      <span className="grow">{error.message}</span>
      {onRetry && (
        <button type="button" className="btn small" onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}

export function CopyButton({ value, label, what = 'Value' }: { value: string; label?: string; what?: string }) {
  const toast = useToast();
  return (
    <button type="button" className={`btn plain small ${label ? '' : 'icon-only'}`} title={`Copy ${what}`} aria-label={label ? undefined : `Copy ${what}`}
      onClick={() => navigator.clipboard.writeText(value).then(() => toast(`${what} copied`), () => toast('Could not copy', 'error'))}>
      <Icon name="copy" size={14} /> {label}
    </button>
  );
}

/**
 * Native <dialog> so focus trapping, Escape and the backdrop come from the
 * platform. `actions` sits bottom-right; a click on the backdrop closes it too.
 */
export function Modal({ open, title, children, actions, onClose, headerAction, wide }: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  /** An icon button next to the title, e.g. "Mark as read". */
  headerAction?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog className={`dialog ${wide ? 'wide' : ''}`} ref={ref}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      // the dialog box itself is the target only when the click landed on the backdrop
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog-head">
        <h2>{title}</h2>
        {headerAction}
      </div>
      <div className="dialog-body">{children}</div>
      {actions && <div className="dialog-actions">{actions}</div>}
    </dialog>
  );
}

/** Unlike window.confirm it can spell out what is about to be lost. */
export function ConfirmDialog({ open, title, children, confirmLabel, danger, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel} actions={
      <>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className={`btn ${danger ? 'danger-solid' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
      </>
    }>
      {children}
    </Modal>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function Disclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="disclosure">
      <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {summary} <Icon name={open ? 'up' : 'down'} size={12} />
      </button>
      {open && children}
    </div>
  );
}
