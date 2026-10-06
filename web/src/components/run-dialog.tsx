import { useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import type { RunInputSpec } from '../types.ts';
import { Icon, Modal } from './ui.tsx';

/** The form's starting values: each question's default, as text. */
export function initialAnswers(inputs: RunInputSpec[]): Record<string, string> {
  return Object.fromEntries(inputs.map((spec) => [spec.name, spec.default === undefined || spec.default === null ? '' : String(spec.default)]));
}

/** Answers as the API takes them: empty ones left out (the server fills in defaults and says what's missing). */
export function toAnswers(values: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== '').map(([name, value]) => [name, value.trim()]));
}

/**
 * "Ask when run?" (02-experience §6): running a routine with questions opens this form first. The
 * server checks the answers; its words come back under the form.
 */
export function RunDialog({ open, name, inputs, onRun, onClose }: {
  open: boolean;
  name: string;
  inputs: RunInputSpec[];
  onRun: (answers: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => initialAnswers(inputs));
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblems([]);
    try {
      await onRun(toAnswers(values));
    } catch (error) {
      setProblems(error instanceof ApiError && error.details.length > 0 ? error.details : [error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={name} onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="run-dialog-form" className="btn primary" disabled={busy}>
            {busy ? <span className="spinner" /> : <Icon name="play" size={14} />} Run
          </button>
        </>
      }>
      <form id="run-dialog-form" className="form-grid" onSubmit={(event) => void submit(event)}>
        {inputs.map((spec) => {
          const id = `run-input-${spec.name}`;
          const set = (value: string) => setValues((current) => ({ ...current, [spec.name]: value }));
          return (
            <label key={spec.name} className="field span-2" htmlFor={id}>
              <span>{spec.label}{spec.required ? '' : ' (optional)'}</span>
              {spec.type === 'choice' ? (
                <select id={id} value={values[spec.name] ?? ''} required={spec.required} onChange={(event) => set(event.target.value)}>
                  <option value="">–</option>
                  {spec.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : (
                <input id={id} value={values[spec.name] ?? ''} required={spec.required}
                  type={spec.type === 'number' ? 'number' : spec.type === 'date' ? 'date' : 'text'}
                  inputMode={spec.type === 'number' ? 'decimal' : undefined}
                  onChange={(event) => set(event.target.value)} />
              )}
            </label>
          );
        })}
        {problems.length > 0 && (
          <div className="error-note span-2" role="alert">
            <Icon name="warning" size={18} />
            <span className="grow">{problems.join(' · ')}</span>
          </div>
        )}
      </form>
    </Modal>
  );
}
