import { useState } from 'react';
import { api } from '../api.ts';
import { actionIcon } from '../action-forms.ts';
import { StepFlow } from '../components/execution.tsx';
import { useToast } from '../components/toast.tsx';
import { Card, Empty, ErrorNote, Icon, Loading } from '../components/ui.tsx';
import { dateTime, describeTrigger, relative } from '../format.ts';
import { navigate, useNow, usePolling } from '../hooks.ts';
import type { Routine } from '../types.ts';
import { ExecutionRow } from './Executions.tsx';

/** Shared "run now" behaviour: trigger, then jump to the live execution view. */
export function useRunRoutine() {
  const toast = useToast();
  return async (routine: Routine) => {
    try {
      const execution = await api.trigger(routine.id);
      navigate(`/executions/${execution.id}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };
}

function ActiveToggle({ routine, onChange }: { routine: Routine; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <label className="switch" title={routine.active ? 'Deaktivieren' : 'Aktivieren'}>
      <input type="checkbox" checked={routine.active} disabled={busy}
        onChange={async () => {
          setBusy(true);
          try {
            await api.setActive(routine.id, !routine.active);
            toast(routine.active ? `„${routine.name}“ deaktiviert` : `„${routine.name}“ aktiviert`);
            onChange();
          } catch (error) {
            toast(error instanceof Error ? error.message : String(error), 'error');
          } finally {
            setBusy(false);
          }
        }} />
      <span className="switch-track" />
      <span className="switch-label">{routine.active ? 'Aktiv' : 'Inaktiv'}</span>
    </label>
  );
}

export function Routines() {
  const routines = usePolling(() => api.routines(), 5000);
  const run = useRunRoutine();
  const now = useNow(10_000);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Routinen</h1>
          <p className="muted">Abläufe aus mehreren Aktionen – manuell oder per Zeitplan ausgelöst.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => navigate('/routines/new')}>
          <Icon name="plus" size={16} /> Neue Routine
        </button>
      </header>
      <ErrorNote error={routines.error} />
      {routines.loading ? <Loading /> : routines.data?.length === 0 ? (
        <Card><Empty>Noch keine Routinen. <a className="link" href="#/routines/new">Erste Routine erstellen</a></Empty></Card>
      ) : (
        <div className="routine-grid">
          {routines.data?.map((routine) => (
            <article key={routine.id} className={`routine-card ${routine.active ? '' : 'inactive'}`}>
              <a href={`#/routines/${routine.id}`} className="routine-card-body">
                <h3>{routine.name}</h3>
                {routine.description && <p className="muted small clamp">{routine.description}</p>}
                <div className="routine-card-meta">
                  <span className="chip"><Icon name={routine.trigger.type === 'schedule' ? 'clock' : 'play'} size={12} /> {describeTrigger(routine.trigger)}</span>
                  <span className="chip">{routine.actions.length} Aktionen</span>
                </div>
                <div className="action-icons" role="group" aria-label="Aktionen">
                  {routine.actions.map((action) => <span key={action.key} title={`${action.key} (${action.type})`}>{actionIcon(action.type)}</span>)}
                </div>
                {routine.active && routine.nextRunAt && <p className="muted small">Nächster Lauf {relative(routine.nextRunAt, now)}</p>}
              </a>
              <footer className="routine-card-foot">
                <ActiveToggle routine={routine} onChange={routines.reload} />
                <button type="button" className="btn small" disabled={!routine.active} onClick={() => run(routine)}
                  title={routine.active ? 'Jetzt ausführen' : 'Erst aktivieren'}>
                  <Icon name="play" size={14} /> Ausführen
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function RoutineDetail({ id }: { id: string }) {
  const toast = useToast();
  const run = useRunRoutine();
  const now = useNow(5000);
  const routine = usePolling(() => api.routine(id), 5000, [id]);
  const executions = usePolling(() => api.routineExecutions(id), 2000, [id]);

  if (routine.error) return <div className="page"><ErrorNote error={routine.error} /><a className="link" href="#/routines">Zurück</a></div>;
  if (!routine.data) return <div className="page"><Loading /></div>;
  const r = routine.data;

  async function remove() {
    if (!confirm(`„${r.name}“ inklusive aller Ausführungen löschen?`)) return;
    try {
      await api.deleteRoutine(r.id);
      toast(`„${r.name}“ gelöscht`);
      navigate('/routines');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  return (
    <div className="page">
      <a className="back" href="#/routines"><Icon name="back" size={16} /> Routinen</a>
      <header className="page-head">
        <div>
          <h1>{r.name} {!r.active && <span className="badge">Inaktiv</span>}</h1>
          {r.description && <p className="muted">{r.description}</p>}
        </div>
        <div className="row">
          <ActiveToggle routine={r} onChange={routine.reload} />
          <button type="button" className="btn ghost" onClick={() => navigate(`/routines/${r.id}/edit`)}><Icon name="edit" size={16} /> Bearbeiten</button>
          <button type="button" className="btn ghost danger" onClick={remove}><Icon name="trash" size={16} /> Löschen</button>
          <button type="button" className="btn primary" disabled={!r.active} onClick={() => run(r)}><Icon name="play" size={16} /> Jetzt ausführen</button>
        </div>
      </header>

      <div className="facts">
        <div><span>Auslöser</span><strong>{describeTrigger(r.trigger)}</strong>{r.trigger.type === 'schedule' && <code>{r.trigger.cron} · {r.trigger.timezone}</code>}</div>
        <div><span>Nächster Lauf</span><strong>{r.active && r.nextRunAt ? relative(r.nextRunAt, now) : '–'}</strong>{r.nextRunAt && <small>{dateTime(r.nextRunAt)}</small>}</div>
        <div><span>Version</span><strong>{r.version}</strong><small>geändert {relative(r.updatedAt, now)}</small></div>
      </div>

      <Card title="Ablauf">
        <StepFlow items={r.actions} />
      </Card>

      <Card title="Ausführungen">
        {executions.loading ? <Loading /> : executions.data?.length === 0 ? <Empty>Diese Routine wurde noch nie ausgeführt.</Empty> : (
          <div className="rows">{executions.data?.map((execution) => <ExecutionRow key={execution.id} execution={execution} now={now} hideName />)}</div>
        )}
      </Card>
    </div>
  );
}
