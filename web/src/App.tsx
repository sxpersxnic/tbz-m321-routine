import { useEffect, useRef } from 'react';
import { sessionStore, api } from './api.ts';
import { Icon, ThemeToggle } from './components/ui.tsx';
import { matchRoute, useReachable, useRoute, usePolling, useSession } from './hooks.ts';
import { Dashboard } from './pages/Dashboard.tsx';
import { ExecutionDetail, Executions } from './pages/Executions.tsx';
import { Notifications } from './pages/Inbox.tsx';
import { Login } from './pages/Login.tsx';
import { RoutineDetail, Routines } from './pages/Routines.tsx';
import { RoutineEditor } from './pages/RoutineEditor.tsx';
import { System } from './pages/System.tsx';
import { Tasks } from './pages/Tasks.tsx';

/**
 * Grouped, because six flat entries hid the one relationship that explains the
 * product: routines are the cause, tasks and notifications are their effect.
 * `short` is what the phone tab bar shows – full labels ellipsise at ~65px.
 */
const NAV_GROUPS = [
  {
    label: 'Automate',
    items: [
      { path: '/', label: 'Overview', short: 'Overview', icon: 'home' },
      { path: '/routines', label: 'Routines', short: 'Routines', icon: 'routines' },
    ],
  },
  {
    label: 'Activity',
    items: [
      { path: '/executions', label: 'Runs', short: 'Runs', icon: 'executions' },
      { path: '/tasks', label: 'Tasks', short: 'Tasks', icon: 'checklist' },
      { path: '/notifications', label: 'Notifications', short: 'Inbox', icon: 'bell' },
    ],
  },
  {
    label: 'Under the hood',
    items: [{ path: '/system', label: 'Infrastructure', short: 'System', icon: 'stack' }],
  },
];

const NAV = NAV_GROUPS.flatMap((group) => group.items);

/** Browser tab title per section, so history and open tabs stay tellable apart. */
function pageTitle(path: string): string {
  if (path === '/routines/new') return 'New routine';
  const item = NAV.slice(1).find((candidate) => path.startsWith(candidate.path));
  return item?.label ?? 'Overview';
}

function Page({ path, refreshUnread }: { path: string; refreshUnread: () => void }) {
  let params: Record<string, string> | null;
  if (path === '/') return <Dashboard />;
  if (path === '/routines') return <Routines />;
  if (path === '/routines/new') return <RoutineEditor />;
  if ((params = matchRoute('/routines/:id/edit', path))) return <RoutineEditor key={params.id} id={params.id} />;
  if ((params = matchRoute('/routines/:id', path))) return <RoutineDetail key={params.id} id={params.id} />;
  if (path === '/executions') return <Executions />;
  if ((params = matchRoute('/executions/:id', path))) return <ExecutionDetail key={params.id} id={params.id} />;
  if (path === '/tasks') return <Tasks />;
  if (path === '/notifications') return <Notifications onChange={refreshUnread} />;
  if (path === '/system') return <System />;
  return (
    <div className="page">
      <h1>Page not found</h1>
      <p className="muted">This address does not exist.</p>
      <a className="btn primary" href="#/" style={{ alignSelf: 'flex-start' }}>Go to overview</a>
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const path = route.split('?')[0];
  const session = useSession();
  const reachable = useReachable();
  const unread = usePolling(() => api.notifications(true), 5000);
  const unreadCount = unread.data?.length ?? 0;
  const section = NAV.slice(1).find((item) => path.startsWith(item.path))?.path ?? '/';
  const main = useRef<HTMLElement>(null);

  // On a hash route change nothing moves for a keyboard or screen-reader user:
  // focus stays on the link they just left. Park it on the new page instead.
  useEffect(() => {
    document.title = `${pageTitle(path)} · Routine`;
    main.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [path]);

  return (
    <div className="shell">
      {/* a button, not an anchor: an href="#main" would be swallowed by the hash router */}
      <button type="button" className="skip-link" onClick={() => main.current?.focus()}>Skip to content</button>
      <aside className="sidebar">
        <a className="brand" href="#/"><img src="/favicon.svg" alt="" width={30} height={30} /> <span>Routine</span></a>
        <nav aria-label="Main navigation">
          {NAV_GROUPS.map((group) => (
            // a real group, not a decorative heading: the label names the list for AT too
            <div key={group.label} className="nav-group" role="group" aria-label={group.label}>
              <span className="nav-group-label" aria-hidden="true">{group.label}</span>
              {group.items.map((item) => {
                const badge = item.path === '/notifications' && unreadCount > 0;
                return (
                  <a key={item.path} href={`#${item.path}`} className={section === item.path ? 'active' : ''}
                    aria-current={section === item.path ? 'page' : undefined}>
                    <Icon name={item.icon} />
                    <span className="nav-label">{item.label}</span>
                    <span className="nav-label-short" aria-hidden="true">{item.short}</span>
                    {badge && <span className="count">{unreadCount}<span className="sr-only"> unread notifications</span></span>}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user">
            <span className="avatar" aria-hidden="true">{(session?.user.displayName ?? '?').slice(0, 1).toUpperCase()}</span>
            <span className="user-text">
              <strong>{session?.user.displayName}</strong>
              <span className="muted small">{session?.user.email}</span>
            </span>
          </div>
          <div className="foot-actions" role="group" aria-label="Account">
            <ThemeToggle />
            <button type="button" className="btn plain small icon-only" onClick={() => sessionStore.set(null)} title="Sign out" aria-label="Sign out">
              <Icon name="logout" size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="content" id="main" ref={main} tabIndex={-1}>
        {!reachable && (
          <div className="offline-banner" role="alert">
            <Icon name="warning" size={16} />
            <span>Offline – data may be out of date</span>
          </div>
        )}
        <Page path={path} refreshUnread={unread.reload} />
      </main>
    </div>
  );
}

export function App() {
  const session = useSession();
  return session ? <Shell /> : <Login />;
}
