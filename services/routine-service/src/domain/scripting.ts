/** Every step the engine evaluates itself (domain `scripting`, 06-engine §9) – one lookup for the engine. */
import { CONTROL_EVALUATORS, ControlError, type Output } from './control.ts';
import { TEXT_LIST_EVALUATORS } from './text-list.ts';

const EVALUATORS: Record<string, (params: Record<string, unknown>) => Output> = { ...CONTROL_EVALUATORS, ...TEXT_LIST_EVALUATORS };

/** Types the engine evaluates itself. */
export const CONTROL_ACTION_TYPES: ReadonlySet<string> = new Set(Object.keys(EVALUATORS));

export function evaluateControlAction(type: string, params: Record<string, unknown>): Output {
  const evaluate = EVALUATORS[type];
  if (!evaluate) throw new ControlError(`${type} is not a scripting action`);
  return evaluate(params);
}
