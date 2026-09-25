import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { actionGlyph, actionLabel, actionSentence, actionTint, conditionWords, describeReference, referenceSource, type Tint } from '../action-forms.ts';
import { between, relative } from '../format.ts';
import type { Execution, Routine } from '../types.ts';
import { Icon, Modal, statusLabel } from './ui.tsx';

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

type Looks = Pick<Routine, 'actions' | 'icon' | 'color'>;

/**
 * A routine's face: the icon and colour its owner chose, else those of its first
 * action – so the same routine looks the same everywhere.
 */
export function routineLook(routine: Looks): { tint: Tint; glyph: string } {
  const first = routine.actions[0]?.type ?? '';
  return { tint: (routine.color as Tint | null) ?? actionTint(first), glyph: routine.icon ?? actionGlyph(first) };
}

export function routineTint(routine: Looks & Pick<Routine, 'active'>): Tint {
  return routine.active ? routineLook(routine).tint : 'grey';
}

export function RoutineGlyph({ routine, size = 40 }: { routine: Looks & Pick<Routine, 'active'>; size?: number }) {
  return (
    <span className={`glyph tint-${routineTint(routine)}`} style={{ width: size, height: size, borderRadius: size * 0.28 }} aria-hidden="true">
      <Icon name={routineLook(routine).glyph} size={Math.round(size * 0.52)} />
    </span>
  );
}

// ---------------------------------------------------------------- appearance pickers

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

export interface Appearance {
  icon: string | null;
  color: string | null;
}

/**
 * Colour swatches. With `auto`, a first swatch stands for null ("Automatic"),
 * drawn in the colour it currently resolves to.
 */
export function ColorPicker({ value, onChange, auto, label = 'Colour', labelledBy }: {
  value: string | null;
  onChange: (next: string | null) => void;
  auto?: { tint: Tint; title: string };
  label?: string;
  labelledBy?: string;
}) {
  return (
    <div className="appearance-group" role="group" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy}>
      {auto && (
        <button type="button" className={`swatch swatch-auto tint-${auto.tint}`} aria-pressed={value === null}
          title={auto.title} aria-label="Automatic colour" onClick={() => onChange(null)}>
          <Icon name="sparkles" size={14} />
        </button>
      )}
      {COLOR_CHOICES.map((color) => (
        <button key={color.tint} type="button" className={`swatch tint-${color.tint}`} aria-pressed={value === color.tint}
          title={color.label} aria-label={color.label} onClick={() => onChange(color.tint)} />
      ))}
    </div>
  );
}

/** A grid of symbols; `auto` works like in ColorPicker. */
export function IconPicker({ value, onChange, auto, labelledBy }: {
  value: string | null;
  onChange: (next: string | null) => void;
  auto?: { glyph: string; title: string };
  labelledBy?: string;
}) {
  return (
    <div className="appearance-group icons" role="group" aria-label={labelledBy ? undefined : 'Icon'} aria-labelledby={labelledBy}>
      {auto && (
        <button type="button" className="icon-choice" aria-pressed={value === null}
          title={auto.title} aria-label="Automatic icon" onClick={() => onChange(null)}>
          <Icon name={auto.glyph} size={20} /><span className="icon-choice-auto" aria-hidden="true">A</span>
        </button>
      )}
      {ICON_CHOICES.map((icon) => (
        <button key={icon.name} type="button" className="icon-choice" aria-pressed={value === icon.name}
          title={icon.label} aria-label={icon.label} onClick={() => onChange(icon.name)}>
          <Icon name={icon.name} size={20} />
        </button>
      ))}
    </div>
  );
}

/**
 * A routine's colour and symbol with a live preview. "Automatic" (null) keeps
 * following the first step, so a routine that never chose still looks right.
 */
export function AppearancePicker({ value, actions, onChange }: {
  value: Appearance;
  actions: Routine['actions'];
  onChange: (next: Appearance) => void;
}) {
  const auto = routineLook({ actions, icon: null, color: null });
  const look = routineLook({ actions, ...value });
  return (
    <div className="appearance">
      <span className={`glyph appearance-preview tint-${look.tint}`} aria-hidden="true"><Icon name={look.glyph} size={34} /></span>
      <ColorPicker value={value.color} onChange={(color) => onChange({ ...value, color })}
        auto={{ tint: auto.tint, title: 'Automatic – colour of the first step' }} />
      <IconPicker value={value.icon} onChange={(icon) => onChange({ ...value, icon })}
        auto={{ glyph: auto.glyph, title: 'Automatic – icon of the first step' }} />
    </div>
  );
}

/** The picker in a dialog: nothing changes until "Done". */
export function AppearanceDialog({ open, value, actions, onClose, onSave }: {
  open: boolean;
  value: Appearance;
  actions: Routine['actions'];
  onClose: () => void;
  onSave: (next: Appearance) => void;
}) {
  const [draft, setDraft] = useState(value);
  // every opening starts from the current look, not from an abandoned earlier pick
  useEffect(() => {
    if (open) setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Modal open={open} title="Icon and colour" onClose={onClose} actions={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" onClick={() => onSave(draft)}>Done</button>
      </>
    }>
      <AppearancePicker value={draft} actions={actions} onChange={setDraft} />
    </Modal>
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
  runIf?: { action: string; is: boolean };
  forEach?: string;
  /** A run's child of a "repeat for each" step. */
  loopIndex?: number;
}

/** "Only if … is true", "For each …", "Item 2" – the control flow of one step, as small tags. */
function FlowTags({ action, actions, types }: { action: FlowAction; actions: FlowAction[]; types: Record<string, string> }) {
  const condition = action.runIf && actions.find((candidate) => candidate.key === action.runIf?.action);
  if (!action.runIf && !action.forEach && action.loopIndex === undefined) return null;
  return (
    <span className="flow-tags">
      {action.runIf && (
        <span className="flow-tag" title={`Runs only if step "${action.runIf.action}" is ${action.runIf.is}`}>
          <Icon name="branch" size={12} />
          <span className="ellipsis">{condition ? conditionWords(condition, action.runIf.is, types) : `${action.runIf.is ? 'If' : 'Otherwise –'} ${action.runIf.action}`}</span>
        </span>
      )}
      {action.forEach && (
        <span className="flow-tag"><Icon name="repeat" size={12} /> For each <RichText text={action.forEach} types={types} /></span>
      )}
      {action.loopIndex !== undefined && <span className="flow-tag"><Icon name="repeat" size={12} /> Item {action.loopIndex + 1}</span>}
    </span>
  );
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
                    <span className="grow story-title">
                      <FlowTags action={action} actions={actions} types={types} />
                      <ActionSentence type={action.type} params={action.params} types={types} />
                    </span>
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
