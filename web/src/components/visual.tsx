import { Fragment, type ReactNode } from 'react';
import { actionGlyph, actionLabel, actionSentence, actionTint, describeReference, referenceSource, type Tint } from '../action-forms.ts';
import { between, relative } from '../format.ts';
import type { Execution, Routine } from '../types.ts';
import { Icon, statusLabel } from './ui.tsx';

/*
 * The visual vocabulary of the app. Apple's Shortcuts taught a generation of
 * non-programmers to build automations with two ideas used here too: every kind
 * of action has its own colour and symbol, and an action reads as a sentence.
 */

// ---------------------------------------------------------------- glyphs & tiles

/** A coloured rounded square with a white symbol – the face of an action type. */
export function ActionGlyph({ type, size = 32 }: { type: string; size?: number }) {
  return (
    <span className={`glyph tint-${actionTint(type)}`} style={{ width: size, height: size, borderRadius: size * 0.28 }} aria-hidden="true">
      <Icon name={actionGlyph(type)} size={Math.round(size * 0.56)} />
    </span>
  );
}

/** A routine takes the colour and symbol of its first action, so the same routine looks the same everywhere. */
export function routineTint(routine: Pick<Routine, 'actions' | 'active'>): Tint {
  if (!routine.active) return 'grey';
  return actionTint(routine.actions[0]?.type ?? '');
}

export function RoutineGlyph({ routine, size = 40 }: { routine: Pick<Routine, 'actions' | 'active'>; size?: number }) {
  return (
    <span className={`glyph tint-${routineTint(routine)}`} style={{ width: size, height: size, borderRadius: size * 0.28 }} aria-hidden="true">
      <Icon name={actionGlyph(routine.actions[0]?.type ?? '')} size={Math.round(size * 0.52)} />
    </span>
  );
}

/** A glyph for a run, when all that is known is the routine's name – coloured by a stable hash. */
const HASH_TINTS: Tint[] = ['sky', 'violet', 'orange', 'green', 'pink'];
export function nameTint(name: string): Tint {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return HASH_TINTS[hash % HASH_TINTS.length];
}

export function Monogram({ name, size = 36, tint }: { name: string; size?: number; tint?: Tint }) {
  return (
    <span className={`glyph tint-${tint ?? nameTint(name)}`} style={{ width: size, height: size, borderRadius: size * 0.28, fontSize: size * 0.42 }} aria-hidden="true">
      {name.trim().slice(0, 1).toUpperCase() || '?'}
    </span>
  );
}

// ---------------------------------------------------------------- status

type Tone = 'ok' | 'err' | 'busy' | 'wait' | 'idle';

export function statusTone(status: string): Tone {
  switch (status) {
    case 'COMPLETED':
    case 'up':
      return 'ok';
    case 'FAILED':
    case 'down':
      return 'err';
    case 'RUNNING':
    case 'DISPATCHED':
    case 'PENDING':
      return 'busy';
    case 'WAITING':
    case 'RETRYING':
      return 'wait';
    default:
      return 'idle';
  }
}

const TONE_ICON: Record<Tone, string> = { ok: 'check', err: 'x', busy: '', wait: 'retry', idle: 'pause' };

/**
 * Status as a symbol inside a circle – shape and colour both change, so a
 * colour-blind reader still tells a tick from a cross. `label` adds the words.
 */
export function StatusIcon({ status, size = 22, label = false }: { status: string; size?: number; label?: boolean }) {
  const tone = statusTone(status);
  return (
    <span className={`status-icon tone-${tone}`}>
      <span className="status-disc" style={{ width: size, height: size }} aria-hidden="true">
        {tone === 'busy' ? <span className="status-spin" /> : <Icon name={TONE_ICON[tone]} size={Math.round(size * 0.6)} />}
      </span>
      {label ? <span className="status-text">{statusLabel(status)}</span> : <span className="sr-only">{statusLabel(status)}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- ring

/** Apple-Watch-style progress ring. `value` is 0–100 or null for "no data yet". */
export function Ring({ value, size = 112, stroke = 12, children, tone = 'ok' }: {
  value: number | null;
  size?: number;
  stroke?: number;
  children?: ReactNode;
  tone?: 'ok' | 'warn' | 'err';
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = value === null ? 0 : Math.max(0, Math.min(100, value)) / 100;
  return (
    <div className={`ring ring-${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} fill="none" />
        <circle className="ring-value" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} fill="none"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - filled)} strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- run history

/**
 * The last runs as a row of bars: height is how long a run took, colour and
 * cap shape say how it ended. A glance answers "is this healthy?" – the list
 * below it answers "what exactly happened?".
 */
export function RunHistory({ executions, now, max = 40 }: { executions: Execution[]; now: number; max?: number }) {
  const runs = executions.slice(0, max).reverse();
  // two bars are not a trend – the list below says it better
  if (runs.length < 5) return null;
  const durations = runs.map((run) => {
    const start = run.startedAt ?? run.createdAt;
    const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
    return Math.max(1, end - new Date(start).getTime());
  });
  const top = Math.log10(Math.max(...durations) + 1);
  const failed = runs.filter((run) => run.status === 'FAILED').length;
  return (
    <figure className="history">
      <ol className="history-bars" aria-label={`Last ${runs.length} runs, ${failed} failed`} title="Bar height = duration, newest on the right">
        {runs.map((run, index) => {
          const height = 18 + 82 * (Math.log10(durations[index] + 1) / (top || 1));
          const tone = statusTone(run.status);
          return (
            <li key={run.id}>
              <a href={`#/executions/${run.id}`} className={`history-bar tone-${tone}`} style={{ height: `${height}%` }}
                title={`${run.routineName} · ${statusLabel(run.status)} · ${relative(run.createdAt, now)} · ${between(run.startedAt ?? run.createdAt, run.finishedAt, now)}`}>
                <span className="sr-only">{run.routineName}: {statusLabel(run.status)}, {relative(run.createdAt, now)}</span>
              </a>
            </li>
          );
        })}
      </ol>
      <figcaption className="history-legend">
        <span><i className="legend-dot tone-ok" /> Succeeded</span>
        {failed > 0 && <span><i className="legend-dot tone-err" /> Failed</span>}
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- sentences

const REFERENCE = /(\{\{[^}]+\}\})/;
const IS_REFERENCE = /^\{\{[^}]+\}\}$/;

/**
 * Text with `{{…}}` references shown as small pills instead of template syntax.
 * The source step is shown by its glyph, so the pill reads "Conditions", not "Conditions (Weather)".
 */
export function RichText({ text, types }: { text: string; types: Record<string, string> }) {
  const parts = text.split(REFERENCE);
  return (
    <>
      {parts.map((part, index) => {
        if (!IS_REFERENCE.test(part)) return <Fragment key={index}>{part}</Fragment>;
        const source = referenceSource(part, types);
        return (
          <span key={index} className="ref-pill" title={describeReference(part, types)}>
            {source && <ActionGlyph type={source} size={14} />}
            {describeReference(part, types, false)}
          </span>
        );
      })}
    </>
  );
}

export function ActionSentence({ type, params, types }: { type: string; params: Record<string, unknown>; types: Record<string, string> }) {
  return (
    <span className="sentence">
      {actionSentence(type, params).map((part, index) =>
        typeof part === 'string'
          ? <Fragment key={index}>{part}</Fragment>
          : <span key={index} className={`token tint-text-${actionTint(type)}`}><RichText text={part.token} types={types} /></span>,
      )}
    </span>
  );
}

// ---------------------------------------------------------------- flow

export interface FlowAction {
  key: string;
  type: string;
  step: number;
  params: Record<string, unknown>;
}

/**
 * A routine as a vertical story: one block per action, joined by a line, with
 * actions that run together sitting side by side under an "In parallel" label.
 * `render` lets a run add its status and details to each block.
 */
export function ActionFlow<T extends FlowAction>({ actions, trigger, aside, compact, selected, onSelect, stateOf }: {
  actions: T[];
  /** Optional first block ("Every weekday at 07:30"), so the story starts where the routine does. */
  trigger?: { icon: string; title: string; detail?: string };
  aside?: (action: T) => ReactNode;
  compact?: boolean;
  selected?: string | null;
  onSelect?: (key: string) => void;
  /** Extra state class per block, e.g. FAILED for a red outline. */
  stateOf?: (action: T) => string | undefined;
}) {
  const steps = [...new Set(actions.map((action) => action.step))].sort((a, b) => a - b);
  const types = Object.fromEntries(actions.map((action) => [action.key, action.type]));
  return (
    <ol className={`story ${compact ? 'compact' : ''}`}>
      {trigger && (
        <li className="story-step">
          <div className="story-block trigger-block">
            <span className="glyph tint-grey" style={{ width: 32, height: 32, borderRadius: 9 }} aria-hidden="true"><Icon name={trigger.icon} size={18} /></span>
            <div className="grow">
              <span className="story-title">{trigger.title}</span>
              {trigger.detail && <span className="story-detail">{trigger.detail}</span>}
            </div>
          </div>
        </li>
      )}
      {steps.map((step) => {
        const lane = actions.filter((action) => action.step === step);
        return (
          <li key={step} className="story-step">
            {lane.length > 1 && <span className="story-parallel"><Icon name="stack" size={13} /> In parallel</span>}
            <div className={lane.length > 1 ? 'story-lane' : undefined}>
              {lane.map((action) => {
                const Tag = onSelect ? 'button' : 'div';
                const state = stateOf?.(action);
                return (
                  <Tag key={action.key} type={onSelect ? 'button' : undefined}
                    className={`story-block ${state ? `state-${state}` : ''} ${selected === action.key ? 'selected' : ''}`}
                    aria-expanded={onSelect ? selected === action.key : undefined}
                    onClick={onSelect ? () => onSelect(action.key) : undefined}>
                    <ActionGlyph type={action.type} size={compact ? 28 : 32} />
                    {/* the sentence already names the action – a type label above it said it twice */}
                    <span className="grow story-title"><ActionSentence type={action.type} params={action.params} types={types} /></span>
                    {aside?.(action)}
                  </Tag>
                );
              })}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Tiny glyph row: the shape of a routine at a glance, capped so twelve weather calls stay one line. */
export function GlyphRow({ types, max = 5, size = 22 }: { types: string[]; max?: number; size?: number }) {
  const shown = types.slice(0, max);
  return (
    <span className="glyph-row" aria-label={types.map(actionLabel).join(', ')} role="img">
      {shown.map((type, index) => <ActionGlyph key={index} type={type} size={size} />)}
      {types.length > max && <span className="glyph-more">+{types.length - max}</span>}
    </span>
  );
}
