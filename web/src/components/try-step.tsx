import { useState } from 'react';
import { formOf } from '../action-forms.ts';
import { api } from '../api.ts';
import { failureCopy } from '../lib/failure-copy.ts';
import type { ActionDefinition, ExecutionAction, ExecutionDetail } from '../types.ts';
import { Icon } from './ui.tsx';

const POLL_MS = 500;
const GIVE_UP_MS = 10_000;

/** A value for a small result line: text as is, anything else as short JSON. */
export function shortValue(value: unknown, max = 60): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? '–' : text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; step: ExecutionAction }
  | { kind: 'failed'; text: string }
  | { kind: 'slow' };

/**
 * "Try this step" (07-web §5.5): runs the step as it is in the editor – saved or not – in a test
 * run with the values of the routine's last run, and shows what it produced right here.
 */
export function TryStep({ routineId, action, types, onOutput }: {
  routineId: string;
  /** The step as the editor has it now; null while its fields can't be read (e.g. broken JSON). */
  action: ActionDefinition | null;
  types: Record<string, string>;
  /** What the step produced – fills the example values of the reference pills. */
  onOutput?: (key: string, output: Record<string, unknown>) => void;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function run() {
    if (!action) return;
    setState({ kind: 'running' });
    try {
      let execution: ExecutionDetail = await api.testStep(routineId, action);
      const until = Date.now() + GIVE_UP_MS;
      while (execution.status !== 'COMPLETED' && execution.status !== 'FAILED' && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        execution = await api.execution(execution.id);
      }
      // the sample's steps are copied in without the tried key, so this is the step that was tried
      const step = execution.actions.find((candidate) => candidate.key === action.key);
      if (execution.status !== 'COMPLETED' && execution.status !== 'FAILED') return setState({ kind: 'slow' });
      if (!step || step.status === 'FAILED') {
        const copy = step && failureCopy(step.errorCode, step, types);
        return setState({ kind: 'failed', text: copy?.sentence ?? step?.error ?? execution.error ?? 'It didn’t work.' });
      }
      if (step.output) onOutput?.(action.key, step.output);
      setState({ kind: 'done', step });
    } catch (error) {
      setState({ kind: 'failed', text: error instanceof Error ? error.message : String(error) });
    }
  }

  const outputs = formOf(action?.type ?? '')?.outputs ?? {};
  return (
    <div className="try-step">
      <button type="button" className="btn small" disabled={!action || state.kind === 'running'} onClick={() => void run()}
        title={action ? 'Runs this step with the values of the last run – nothing is sent or created' : 'Fix the fields first'}>
        {state.kind === 'running' ? <span className="spinner" /> : <Icon name="play" size={14} />} Try this step
      </button>
      <div className="try-result" aria-live="polite">
        {state.kind === 'done' && typeof state.step.output?.wouldDo === 'string' && (
          // a preview: what the step would do – nothing was sent
          <span className="small">{state.step.output.wouldDo}</span>
        )}
        {state.kind === 'done' && typeof state.step.output?.wouldDo !== 'string' && (
          state.step.output && Object.keys(state.step.output).length > 0 ? (
            <dl className="kv">
              {Object.entries(state.step.output).filter(([name]) => !Object.keys(outputs).length || name in outputs).map(([name, value]) => (
                <div key={name} className="contents"><dt>{outputs[name] ?? name}</dt><dd>{shortValue(value)}</dd></div>
              ))}
            </dl>
          ) : <span className="muted small">Done</span>
        )}
        {state.kind === 'failed' && <span className="try-failed"><Icon name="warning" size={14} /> {state.text}</span>}
        {state.kind === 'slow' && <span className="muted small">No answer yet – the service may be catching up.</span>}
      </div>
    </div>
  );
}
