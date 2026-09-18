import { api } from '../api.ts';
import { TemplateGallery, Welcome } from '../components/onboarding.tsx';
import { Empty, ErrorNote, Icon, Section, SeeAll, Skeleton } from '../components/ui.tsx';
import { RoutineGlyph, Ring, RunHistory, StatusIcon } from '../components/visual.tsx';
import { clock, greeting, longDate, plural, relative } from '../format.ts';
import { navigate, useNow, usePolling, useSession } from '../hooks.ts';
import { ExecutionRow } from './Executions.tsx';
import { RoutineTile } from './Routines.tsx';

const sum = (counts: Record<string, number | undefined>) => Object.values(counts).reduce<number>((total, n) => total + (n ?? 0), 0);

export function Dashboard() {
  const now = useNow(5000);
  const session = useSession();
  const firstName = session?.user.displayName?.split(' ')[0];
  const routines = usePolling(() => api.routines(), 5000);
  // Nothing on the welcome screen reads these, so they stop polling until there
  // is a routine to report on (0 = off).
  const idle = routines.data?.length === 0 ? 0 : undefined;
  const executions = usePolling(() => api.executions({ limit: 40 }), idle ?? 2000);
  // Totals are aggregated by the routine service – a page of the list would cap them.
  const stats = usePolling(() => api.executionStats(24), idle ?? 2000);
  const tasks = usePolling(() => api.tasks('OPEN'), idle ?? 5000);
  const system = usePolling(() => api.system(), idle ?? 5000);

  // Until we know, show neither: a wall of zeros and a welcome screen say
  // opposite things, and flashing one before the other is its own confusion.
  if (!routines.data) {
    return (
      <div className="page">
        <header className="page-head"><div><span className="eyebrow">{longDate()}</span><h1>{greeting()}</h1></div></header>
        <ErrorNote error={routines.error} onRetry={routines.reload} />
        <div className="card"><Skeleton lines={4} /></div>
      </div>
    );
  }

  // A dashboard measures a system that is running. With no routines there is
  // nothing to measure, and tiles reading 0 teach a newcomer nothing.
  if (routines.data.length === 0) {
    return (
      <div className="page">
        <ErrorNote error={routines.error} onRetry={routines.reload} />
        <Welcome name={firstName} />
        <TemplateGallery onCreated={routines.reload} />
      </div>
    );
  }

  const all = routines.data;
  const byId = new Map(all.map((routine) => [routine.id, routine]));
  const runs = executions.data ?? [];
  const byStatus = stats.data?.byStatus ?? {};
  const total = sum(byStatus);
  const completed = byStatus.COMPLETED ?? 0;
  const failed = byStatus.FAILED ?? 0;
  const finished = completed + failed;
  const successRate = finished ? Math.round((completed / finished) * 100) : null;
  const inFlight = sum(stats.data?.inFlight ?? {});
  const openTasks = tasks.data ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const overdue = openTasks.filter((task) => task.dueDate && task.dueDate < today);
  const services = Object.entries(system.data?.services ?? {});
  const down = services.filter(([, service]) => service.status === 'down').map(([name]) => name);
  if (system.data?.broker === 'down') down.push('rabbitmq');
  const dayAgo = now - 86_400_000;
  const recentFailures = runs.filter((run) => run.status === 'FAILED' && new Date(run.createdAt).getTime() > dayAgo).slice(0, 3);

  const upcoming = all
    .filter((routine) => routine.active && routine.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
    .slice(0, 5);
  // Favourites without a favourite flag: what is switched on, next-due first.
  const featured = [...all]
    .sort((a, b) => Number(b.active) - Number(a.active) || (a.nextRunAt ?? 'z').localeCompare(b.nextRunAt ?? 'z'))
    .slice(0, 7);

  const headline = total === 0
    ? 'Nothing has run yet today.'
    : failed === 0 ? 'Everything is running smoothly.' : failed === 1 ? 'One run failed.' : `${failed} runs failed.`;
  // the stats below already carry the numbers – a sentence repeating them is noise
  const subline = total > 0 ? null
    : upcoming[0] ? `Up next: ${upcoming[0].name} ${relative(upcoming[0].nextRunAt, now)}` : 'Start a routine to see it in action.';
  const ringTone = successRate === null || successRate >= 90 ? 'ok' : successRate >= 60 ? 'warn' : 'err';
  const needsAttention = recentFailures.length > 0 || overdue.length > 0 || down.length > 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="eyebrow">{longDate(new Date(now))}</span>
          <h1>{greeting(new Date(now))}{firstName ? `, ${firstName}` : ''}</h1>
        </div>
        <button type="button" className="btn primary" onClick={() => navigate('/routines/new')}>
          <Icon name="plus" size={16} /> New routine
        </button>
      </header>

      {/* polling keeps the last good values on screen, so a failure has to be said out loud */}
      <ErrorNote error={executions.error ?? stats.error ?? routines.error ?? system.error}
        onRetry={() => { executions.reload(); stats.reload(); routines.reload(); tasks.reload(); system.reload(); }} />

      <section className="hero" aria-labelledby="today-title">
        <Ring value={successRate} tone={ringTone}>
          <span>
            <span className="ring-number">{successRate === null ? '–' : `${successRate}%`}</span>
            <span className="ring-unit">succeeded</span>
          </span>
        </Ring>
        <div className="hero-text">
          <h2 id="today-title">{headline}</h2>
          {subline && <p>{subline}</p>}
          <div className="stat-row">
            <a className="stat" href="#/executions">
              <span className="stat-value">{stats.data ? total : '–'}</span>
              <span className="stat-label">Runs (24 h)</span>
            </a>
            <a className={`stat ${inFlight ? 'tone-busy' : ''}`} href="#/executions?status=RUNNING">
              <span className="stat-value">{stats.data ? inFlight : '–'}</span>
              <span className="stat-label">Active</span>
            </a>
            <a className={`stat ${failed ? 'tone-err' : ''}`} href="#/executions?status=FAILED">
              <span className="stat-value">{stats.data ? failed : '–'}</span>
              <span className="stat-label">Failed</span>
            </a>
            <a className="stat" href="#/tasks">
              <span className="stat-value">{tasks.data ? openTasks.length : '–'}</span>
              <span className="stat-label">Tasks</span>
            </a>
          </div>
        </div>
      </section>

      {needsAttention && (
        <Section id="attention-title" title="Needs attention">
          <div className="attention">
            {down.length > 0 && (
              <a className="attention-item" href="#/system">
                <StatusIcon status="down" size={34} />
                <span className="grow">
                  <span className="row-title">{down.length === 1 ? 'A service is offline' : `${down.length} services are offline`}</span>
                  <span className="row-sub">{down.join(', ')}</span>
                </span>
                <Icon name="chevron" size={16} />
              </a>
            )}
            {recentFailures.map((run) => (
              <a key={run.id} className="attention-item" href={`#/executions/${run.id}`}>
                <StatusIcon status="FAILED" size={34} />
                <span className="grow">
                  <span className="row-title">{run.routineName} failed</span>
                  <span className="row-sub">{relative(run.createdAt, now)}{run.error ? ` · ${run.error}` : ''}</span>
                </span>
                <Icon name="chevron" size={16} />
              </a>
            ))}
            {overdue.length > 0 && (
              <a className="attention-item" href="#/tasks">
                <span className="glyph tint-orange" aria-hidden="true"><Icon name="flag" size={18} /></span>
                <span className="grow">
                  <span className="row-title">{plural(overdue.length, 'task', 'tasks')} overdue</span>
                  <span className="row-sub">{[...new Set(overdue.map((task) => task.title))].slice(0, 3).join(', ')}</span>
                </span>
                <Icon name="chevron" size={16} />
              </a>
            )}
          </div>
        </Section>
      )}

      <Section id="routines-title" title="Routines" action={<SeeAll href="#/routines" />}>
        <div className="tile-grid">
          {featured.map((routine) => <RoutineTile key={routine.id} routine={routine} onChanged={routines.reload} />)}
          <a className="tile-new" href="#/routines/new"><Icon name="plus" size={26} /> New routine</a>
        </div>
      </Section>

      <div className="grid-2">
        <Section id="next-title" title="Up next">
          {upcoming.length === 0 ? (
            <div className="card">
              <Empty icon="calendar" title="Nothing scheduled" />
            </div>
          ) : (
            <ul className="list">
              {upcoming.map((routine) => (
                <li key={routine.id}>
                  <a href={`#/routines/${routine.id}`} className="list-row">
                    <RoutineGlyph routine={routine} size={36} />
                    <span className="grow">
                      <span className="row-title">{routine.name}</span>
                      <span className="row-sub">{relative(routine.nextRunAt, now)}</span>
                    </span>
                    <strong className="row-meta" style={{ color: 'var(--text)' }}>{clock(routine.nextRunAt)}</strong>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="recent-title" title="Recent runs" action={<SeeAll href="#/executions" />}>
          {executions.loading ? <div className="card"><Skeleton lines={3} /></div> : runs.length === 0 ? (
            <div className="card">
              <Empty icon="executions" title="No runs yet" action={<a className="btn" href="#/routines">Go to routines</a>} />
            </div>
          ) : (
            <>
              {runs.length >= 5 && <div className="card"><RunHistory executions={runs} now={now} max={30} /></div>}
              <ul className="list">
                {runs.slice(0, 3).map((execution) => (
                  <li key={execution.id}><ExecutionRow execution={execution} now={now} routine={byId.get(execution.routineId)} /></li>
                ))}
              </ul>
            </>
          )}
        </Section>
      </div>

      {system.data && (
        <a className="system-line" href="#/system">
          <StatusIcon status={down.length === 0 ? 'up' : 'down'} size={22} />
          <span className="grow">
            {down.length === 0 ? `All ${services.length + 1} services online` : `${down.length} of ${services.length + 1} services offline`}
          </span>
          <span className="see-all">Infrastructure <Icon name="chevron" size={14} /></span>
        </a>
      )}
    </div>
  );
}
