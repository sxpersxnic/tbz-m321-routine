import { sessionStore, api } from './api.ts';
import { Icon } from './components/ui.tsx';
import { matchRoute, useRoute, usePolling, useSession } from './hooks.ts';
import { Dashboard } from './pages/Dashboard.tsx';
import { ExecutionDetail, Executions } from './pages/Executions.tsx';
import { Notifications, Tasks } from './pages/Inbox.tsx';
import { Login } from './pages/Login.tsx';
import { RoutineDetail, Routines } from './pages/Routines.tsx';
import { RoutineEditor } from './pages/RoutineEditor.tsx';
import { System } from './pages/System.tsx';

const NAV = [
  { path: '/', label: 'Übersicht', icon: 'dashboard' },
  { path: '/routines', label: 'Routinen', icon: 'routines' },
  { path: '/executions', label: 'Ausführungen', icon: 'executions' },
  { path: '/tasks', label: 'Aufgaben', icon: 'tasks' },
  { path: '/notifications', label: 'Benachrichtigungen', icon: 'bell' },
  { path: '/system', label: 'System', icon: 'system' },
];

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
      <h1>Seite nicht gefunden</h1>
      <a className="link" href="#/">Zur Übersicht</a>
    </div>
  );
}

function Shell() {
  const path = useRoute();
  const session = useSession();
  const unread = usePolling(() => api.notifications(true), 5000);
  const unreadCount = unread.data?.length ?? 0;
  const section = NAV.slice(1).find((item) => path.startsWith(item.path))?.path ?? '/';

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/"><img src="/favicon.svg" alt="" width={28} height={28} /> <span>Routine</span></a>
        <nav aria-label="Hauptnavigation">
          {NAV.map((item) => (
            <a key={item.path} href={`#${item.path}`} className={section === item.path ? 'active' : ''} aria-current={section === item.path ? 'page' : undefined}>
              <Icon name={item.icon} />
              <span className="nav-label">{item.label}</span>
              {item.path === '/notifications' && unreadCount > 0 && <span className="count">{unreadCount}</span>}
            </a>
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
          <button type="button" className="btn ghost small" onClick={() => sessionStore.set(null)} title="Abmelden">
            <Icon name="logout" size={16} /> <span className="nav-label">Abmelden</span>
          </button>
        </div>
      </aside>
      <main className="content">
        <Page path={path} refreshUnread={unread.reload} />
      </main>
    </div>
  );
}

export function App() {
  const session = useSession();
  return session ? <Shell /> : <Login />;
}
