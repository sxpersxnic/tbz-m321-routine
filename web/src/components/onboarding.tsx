import { useState } from 'react';
import { actionShort, actionTint } from '../action-forms.ts';
import { api } from '../api.ts';
import { describeTrigger, TRIGGER_ICONS } from '../format.ts';
import { navigate } from '../hooks.ts';
import { startRoutine } from '../pages/Routines.tsx';
import { TEMPLATES, type Template } from '../templates.ts';
import type { ExecutionAction } from '../types.ts';
import { useToast } from './toast.tsx';
import { Icon, Section } from './ui.tsx';
import { ActionGlyph, GlyphRow, StatusIcon } from './visual.tsx';

/**
 * What a first-time user is missing is not a feature, it is the model: a trigger
 * starts a routine, its actions run in steps, and the things they produce show up
 * as tasks and notifications. Three panels say that faster than any paragraph.
 */
export function Welcome({ name }: { name?: string }) {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <h1 id="welcome-title">{name ? `Hi ${name}, let Routine do the work.` : 'Let Routine do the work.'}</h1>
      <p>Recurring chores – set them up once, then they run by themselves.</p>
      <ol className="concept">
        <li>
          <span className="num">1</span>
          <h3>When?</h3>
          <p>At the push of a button or on a schedule.</p>
        </li>
        <li>
          <span className="num">2</span>
          <h3>What?</h3>
          <p>Steps like getting the weather, creating a task, sending a notification.</p>
        </li>
        <li>
          <span className="num">3</span>
          <h3>Result</h3>
          <p>New <a href="#/tasks">tasks</a> and <a href="#/notifications">notifications</a>, every <a href="#/executions">run</a> live.</p>
        </li>
      </ol>
    </section>
  );
}

const templateTint = (template: Template) => actionTint(template.routine.actions[0]?.type ?? '');

/** "Weather → Task → Notification" – the shape of a template in words. */
function chain(template: Template): string {
  const steps = [...new Set(template.routine.actions.map((action) => action.step))].sort((a, b) => a - b);
  return steps.map((step) => {
    const actions = template.routine.actions.filter((action) => action.step === step);
    const names = [...new Set(actions.map((action) => action.type))].map((type) => {
      const count = actions.filter((action) => action.type === type).length;
      return count > 1 ? `${count}× ${actionShort(type)}` : actionShort(type);
    });
    return names.join(' + ');
  }).join(' → ');
}

/**
 * One click has to carry a new user all the way through the loop: create, start,
 * and land on the running execution. Reading about it does not produce the
 * moment where the model clicks.
 */
export function TemplateGallery({ onCreated }: { onCreated?: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string>();

  async function use(template: Template, run: boolean) {
    setBusy(template.id);
    try {
      const routine = await api.createRoutine(template.routine);
      // routines are created inactive, and an inactive one cannot be triggered at
      // all – not just on a schedule. Activating is what makes it runnable.
      const active = await api.setActive(routine.id, true);
      onCreated?.();
      if (!run) {
        toast(`"${routine.name}" created`);
        navigate(`/routines/${routine.id}`);
        return;
      }
      // a webhook template is tried through its own URL, like the external system would
      const executionId = await startRoutine(active);
      toast(`"${routine.name}" is running`);
      navigate(`/executions/${executionId}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(undefined);
    }
  }

  const render = (template: Template) => (
    <li key={template.id} className="template-card">
      <div className={`template-cover tint-${templateTint(template)}`}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <GlyphRow types={template.routine.actions.map((action) => action.type)} size={30} max={4} />
          {template.kind === 'demo' && <span className="demo-tag">Demo</span>}
        </div>
        <div>
          <h3>{template.label}</h3>
          <p className="small" style={{ opacity: 0.9 }}>{chain(template)}</p>
        </div>
      </div>
      <div className="template-body">
        {/* one line: what a starter does for you, or what a demo makes visible */}
        <p className="template-does">{template.kind === 'demo' ? template.teaches : template.does}</p>
        <span className="template-when">
          <Icon name={TRIGGER_ICONS[template.routine.trigger.type]} size={13} /> {describeTrigger(template.routine.trigger)}
        </span>
        <div className="template-actions">
          <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={() => void use(template, true)}>
            {busy === template.id ? <><span className="spinner" /> Starting</> : <><Icon name="play" size={14} /> Try it</>}
          </button>
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void use(template, false)}>
            Add
          </button>
        </div>
      </div>
    </li>
  );

  const starters = TEMPLATES.filter((template) => template.kind === 'starter');
  const demos = TEMPLATES.filter((template) => template.kind === 'demo');

  return (
    <div className="gallery">
      <Section id="gallery-starter" title="Templates"
        action={<a className="see-all" href="#/routines/new">Build your own <Icon name="chevron" size={14} /></a>}>
        <ul className="template-grid">{starters.map(render)}</ul>
      </Section>
      <Section id="gallery-demo" title="Demos"
        description={<>Each one makes a behaviour of the distributed system visible – best watched next to <a className="link" href="#/system">Infrastructure</a>.</>}>
        <ul className="template-grid">{demos.map(render)}</ul>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- run outcome

interface Outcome {
  type: string;
  text: string;
  detail?: string;
  href?: string;
  linkLabel?: string;
  bad?: boolean;
}

const text = (output: Record<string, unknown> | null, key: string) => {
  const value = output?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
};

/**
 * What an action actually produced, in the words of someone who does not know
 * the action types. This is the only thing that answers "so what did I get?".
 */
function outcomeOf(action: ExecutionAction): Outcome | null {
  const base = { type: action.type };
  if (action.status === 'FAILED') {
    return { ...base, text: `${actionShort(action.type)} failed`, detail: action.error ?? undefined, bad: true };
  }
  if (action.status === 'SKIPPED') {
    return { ...base, text: `${actionShort(action.type)} skipped`, detail: 'An earlier step failed', bad: true };
  }
  if (action.status !== 'COMPLETED') return null;

  switch (action.type) {
    case 'task.create':
      return { ...base, text: 'New task', detail: text(action.output, 'title'), href: '#/tasks', linkLabel: 'Tasks' };
    case 'notification.send':
      return { ...base, text: 'Notification sent', detail: text(action.params as Record<string, unknown>, 'title'), href: '#/notifications', linkLabel: 'Notifications' };
    case 'weather.get':
      return { ...base, text: 'Weather', detail: text(action.output, 'summary') };
    case 'summary.generate':
      return { ...base, text: 'Summary', detail: text(action.output, 'title') };
    case 'http.request': {
      const status = text(action.output, 'status');
      const attempts = action.attempts > 1 ? ` · attempt ${action.attempts}` : '';
      return { ...base, text: 'Webhook called', detail: status ? `HTTP ${status}${attempts}` : undefined };
    }
    default:
      return { ...base, text: `${actionShort(action.type)} done` };
  }
}

/** Shown once a run has finished – the payoff a first-time user came for. */
export function RunOutcome({ actions, status }: { actions: ExecutionAction[]; status: string }) {
  if (status !== 'COMPLETED' && status !== 'FAILED') return null;
  const outcomes = actions.map(outcomeOf).filter((outcome): outcome is Outcome => outcome !== null);
  if (outcomes.length === 0) return null;
  // twelve weather reports are one card with a count, not twelve cards
  const shown = outcomes.length > 6 ? outcomes.slice(0, 5) : outcomes;
  const hidden = outcomes.length - shown.length;

  return (
    <Section id="outcome-title" title="Result">
      <div className="outcome-grid">
        {shown.map((outcome, index) => {
          const body = (
            <>
              {outcome.bad ? <StatusIcon status="FAILED" size={32} /> : <ActionGlyph type={outcome.type} size={32} />}
              <span className="grow">
                <strong>{outcome.text}</strong>
                {outcome.detail && <span className="detail">{outcome.detail}</span>}
                {outcome.href && <span className="go">{outcome.linkLabel} <Icon name="chevron" size={12} /></span>}
              </span>
            </>
          );
          return outcome.href
            ? <a key={index} className="outcome-card" href={outcome.href}>{body}</a>
            : <div key={index} className={`outcome-card ${outcome.bad ? 'bad' : ''}`}>{body}</div>;
        })}
        {hidden > 0 && (
          <div className="outcome-card">
            <span className="glyph tint-grey" style={{ width: 32, height: 32, borderRadius: 9 }} aria-hidden="true"><Icon name="more" size={18} /></span>
            <span className="grow"><strong>+ {hidden} more</strong><span className="detail">See steps</span></span>
          </div>
        )}
      </div>
    </Section>
  );
}
