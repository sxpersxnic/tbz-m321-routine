import { ACTION_FORMS, describeReference } from '../action-forms.ts';
import type { ErrorCode } from '../types.ts';

/**
 * Plain-language failures (docs/v2/02-experience.md §8): every failed step says what happened in
 * one sentence and offers one thing to do about it. The raw error stays under "Under the hood".
 */

/** What the failure card offers: its button (or link). */
export type FailureAction = 'editStep' | 'retry' | 'openConnection' | 'openSettings' | 'openRun';

export const FAILURE_ACTION_LABELS: Record<FailureAction, string> = {
  editStep: 'Edit step',
  retry: 'Retry from here',
  openConnection: 'Open connection',
  openSettings: 'Open settings',
  openRun: 'Open that run',
};

export interface FailureCopy {
  sentence: string;
  action: FailureAction;
}

/** The failed step as far as the copy needs it. */
export interface FailedStep {
  type: string;
  params: Record<string, unknown>;
  /** The raw error text – details like the missing param are read from it. */
  error: string | null;
}

/** Where a step type belongs, in the words of the sidebar. */
const DOMAIN_NAMES: Record<string, string> = {
  task: 'Tasks',
  notification: 'Notifications',
  http: 'Connections',
  weather: 'Connections',
  email: 'Connections',
  summary: 'Connections',
  routine: 'Routines',
  variable: 'Scripting',
  condition: 'Scripting',
  math: 'Scripting',
};

/** What a REFERENCE_GONE step pointed to. */
const THINGS: Record<string, string> = { 'routine.run': 'routine', 'task.create': 'list' };

const domainOf = (type: string) => DOMAIN_NAMES[type.slice(0, type.indexOf('.'))] ?? 'This service';
const trimDot = (text: string) => text.trim().replace(/\.$/, '');

/** `param "city" is required` → "City" (the field's label); anything else → the message itself. */
function paramDetail(step: FailedStep): string {
  const raw = trimDot(step.error ?? '');
  const param = /param "([^"]+)"/.exec(raw)?.[1];
  if (param) return ACTION_FORMS[step.type]?.fields.find((field) => field.name === param)?.label ?? param;
  return raw || 'a value';
}

/** `template reference "{{actions.weather.summary}}" …` → "Forecast (Weather)". */
function referenceDetail(step: FailedStep, types: Record<string, string>): string {
  const reference = /\{\{[^}]+\}\}/.exec(step.error ?? '')?.[0];
  return reference ? describeReference(reference, types) : 'a value from an earlier step';
}

const COPY: Record<ErrorCode, { action: FailureAction; sentence: (step: FailedStep, types: Record<string, string>) => string; short: string }> = {
  NOT_FOUND: { action: 'editStep', short: "The website said this page doesn't exist.", sentence: () => "The website said this page doesn't exist. The address may have changed." },
  UNAUTHORIZED: { action: 'openConnection', short: "The service didn't accept the key.", sentence: () => "The service didn't accept the key. It may have expired." },
  FORBIDDEN_HOST: { action: 'editStep', short: "Routine isn't allowed to call this address.", sentence: () => "Routine isn't allowed to call this address." },
  TIMEOUT: { action: 'retry', short: 'The service took too long to answer.', sentence: () => 'The service took too long to answer.' },
  UNREACHABLE: { action: 'retry', short: "The service couldn't be reached.", sentence: () => "The service couldn't be reached." },
  RATE_LIMITED: { action: 'retry', short: 'The service asked Routine to slow down.', sentence: () => 'The service asked Routine to slow down.' },
  INVALID_PARAMS: { action: 'editStep', short: 'A step is missing something.', sentence: (step) => `This step is missing something: ${paramDetail(step)}.` },
  TEMPLATE_ERROR: { action: 'editStep', short: "A value a step uses wasn't there.", sentence: (step, types) => `A value this step uses wasn't there: ${referenceDetail(step, types)}.` },
  NOT_AVAILABLE: { action: 'openSettings', short: "A step isn't available any more.", sentence: (step) => `${domainOf(step.type)} isn't turned on or doesn't know this step any more.` },
  REFERENCE_GONE: { action: 'editStep', short: 'Something a step uses was deleted.', sentence: (step) => `The ${THINGS[step.type] ?? 'item'} this step uses was deleted.` },
  SUBROUTINE_FAILED: {
    action: 'openRun',
    short: 'A routine it called failed.',
    sentence: (step) => (typeof step.params.routineName === 'string' ? `The routine "${step.params.routineName}" it called failed.` : 'The routine it called failed.'),
  },
  AWAIT_EXPIRED: { action: 'retry', short: 'Nobody did this in time.', sentence: () => 'Nobody did this in time.' },
  QUOTA_EXCEEDED: { action: 'openSettings', short: "This month's AI allowance is used up.", sentence: () => "This month's AI allowance is used up." },
  AI_REFUSED: { action: 'editStep', short: 'The AI step declined this request.', sentence: () => 'The AI step declined this request.' },
  INPUT_TOO_LARGE: { action: 'editStep', short: 'A step got more than it can handle.', sentence: (step) => `This step got more than it can handle: ${trimDot(step.error ?? 'too much input')}.` },
  CONFLICT: { action: 'retry', short: 'Something changed while this step ran.', sentence: () => "Something changed in the meantime, so this step couldn't go ahead." },
  CANCELLED: { action: 'retry', short: 'The run was cancelled.', sentence: () => 'You cancelled this run.' },
  INTERNAL: { action: 'retry', short: 'Something went wrong on our side.', sentence: () => 'Something went wrong on our side.' },
};

/**
 * The sentence and action for a failed step. `types` maps the run's action keys to their types, so
 * references read as "Forecast (Weather)". Null for failures without a code (runs from before v2):
 * those keep showing their raw error.
 */
export function failureCopy(code: ErrorCode | null | undefined, step: FailedStep, types: Record<string, string> = {}): FailureCopy | null {
  const copy = code ? (COPY[code] ?? COPY.INTERNAL) : null;
  return copy && { sentence: copy.sentence(step, types), action: copy.action };
}

/** The field of the step the failure is about – "Edit step" puts the cursor there. */
export function failureField(code: ErrorCode | null | undefined, step: FailedStep): string | undefined {
  if (code === 'INVALID_PARAMS') return /param "([^"]+)"/.exec(step.error ?? '')?.[1];
  if (step.type === 'http.request' && (code === 'NOT_FOUND' || code === 'FORBIDDEN_HOST' || code === 'UNAUTHORIZED')) return 'url';
  return undefined;
}

/** One short sentence for a run row, where the failed step itself isn't known. */
export function failureLine(code: ErrorCode | null | undefined): string | null {
  return code ? (COPY[code] ?? COPY.INTERNAL).short : null;
}

export const ERROR_CODES = Object.keys(COPY) as ErrorCode[];
