import { api } from '../api.ts';
import { ExecutionRow } from './Executions.tsx';
import { Card, Empty, Icon, Kpi, Loading } from '../components/ui.tsx';
import { describeTrigger, relative } from '../format.ts';
import { navigate, useNow, usePolling } from '../hooks.ts';

export function Dashboard() {
  const now = useNow(5000);
  const executions = usePolling(() => api.executions({ limit: 200 }), 2000);
  const routines = usePolling(() => api.routines(), 5000);
  const tasks = usePolling(() => api.tasks('OPEN'), 5000);
  const system = usePolling(() => api.system(), 3000);

  const all = executions.data ?? [];
  const last24h = all.filter((execution) => now - new Date(execution.createdAt).getTime() < 86_400_000);
  const finished = last24h.filter((execution) => execution.status === 'COMPLETED' || execution.status === 'FAILED');
  const successRate = finished.length ? Math.round((finished.filter((execution) => execution.status === 'COMPLETED').length / finished.length) * 100) : null;
  const inFlight = all.filter((execution) => ['PENDING', 'RUNNING', 'WAITING'].includes(execution.status));
  const waiting = inFlight.filter((execution) => execution.status === 'WAITING').length;
  const upcoming = (routines.data ?? [])
    .filter((routine) => routine.active && routine.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
    .slice(0, 5);
  const services = Object.entries(system.data?.services ?? {});
  const down = services.filter(([, service]) => service.status === 'down').map(([name]) => name);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Übersicht</h1>
          <p className="muted">Was in deinen Routinen gerade passiert.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => navigate('/routines/new')}>
          <Icon name="plus" size={16} /> Neue Routine
        </button>
      </header>

      <div className="kpis">
        <Kpi label="Aktive Routinen" value={routines.data ? routines.data.filter((routine) => routine.active).length : '–'}
          hint={routines.data ? `von ${routines.data.length}` : undefined} />
        <Kpi label="Ausführungen (24 h)" value={executions.data ? last24h.length : '–'} />
        <Kpi label="Erfolgsquote (24 h)" value={successRate === null ? '–' : `${successRate} %`}
          tone={successRate === null ? undefined : successRate >= 90 ? 'ok' : successRate >= 60 ? 'warn' : 'err'} />
        <Kpi label="Laufend" value={executions.data ? inFlight.length : '–'} hint={waiting ? `${waiting} wartend` : undefined} tone={waiting ? 'warn' : undefined} />
        <Kpi label="Offene Aufgaben" value={tasks.data ? tasks.data.length : '–'} />
        <Kpi label="System" value={system.data ? (down.length ? `${down.length} down` : 'OK') : '–'}
          hint={down.length ? down.join(', ') : system.data ? `${services.length} Services up` : undefined}
          tone={system.data ? (down.length ? 'err' : 'ok') : undefined} />
      </div>

      <div className="grid-2">
        <Card title="Letzte Ausführungen" actions={<a className="link" href="#/executions">Alle anzeigen</a>}>
          {executions.loading ? <Loading /> : all.length === 0 ? (
            <Empty>Noch keine Ausführungen – starte eine Routine.</Empty>
          ) : (
            <div className="rows">{all.slice(0, 8).map((execution) => <ExecutionRow key={execution.id} execution={execution} now={now} />)}</div>
          )}
        </Card>
        <div className="stack">
          <Card title="Nächste geplante Läufe">
            {upcoming.length === 0 ? <Empty>Keine aktiven Zeitpläne.</Empty> : (
              <ul className="plain-list">
                {upcoming.map((routine) => (
                  <li key={routine.id}>
                    <a href={`#/routines/${routine.id}`} className="list-link">
                      <Icon name="clock" size={16} />
                      <span className="grow">
                        <strong>{routine.name}</strong>
                        <span className="muted small block">{describeTrigger(routine.trigger)}</span>
                      </span>
                      <span className="muted small">{relative(routine.nextRunAt, now)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Services" actions={<a className="link" href="#/system">Topologie</a>}>
            <div className="service-dots">
              {services.map(([name, service]) => (
                <span key={name} className={`service-dot ${service.status}`} title={`${name}: ${service.status}`}>{name}</span>
              ))}
              {system.data && <span className={`service-dot ${system.data.broker}`}>rabbitmq</span>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
