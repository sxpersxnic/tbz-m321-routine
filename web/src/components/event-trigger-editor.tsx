/**
 * The event trigger in the routine editor (docs/v2/07-web.md §5.6): domain → event → filter rows
 * "field · operator · value". Fields come from the trigger's manifest, operators are condition.if's;
 * a list or routine field gets a picker instead of an id to type.
 */
import type { Catalog } from '../catalog/catalog.ts';
import { FILTER_OPERATORS, MAX_FILTER_CONDITIONS, refPicker } from '../lib/event-trigger.ts';
import type { Routine, TaskList } from '../types.ts';
import { Icon, IconButton } from './ui.tsx';

/** A filter row while it is edited – the value as typed. */
export interface DraftCondition {
  uid: string;
  field: string;
  operator: string;
  value: string;
}

const unary = (operator: string) => FILTER_OPERATORS.find((candidate) => candidate.value === operator)?.unary === true;

/**
 * The filter as the API takes it: no value for "is empty" / "is not empty", numbers stay text
 * (the comparison treats "5" and 5 alike).
 *
 * @example toFilter([{ uid: 'a', field: 'listId', operator: 'equals', value: workId }]) // → [{ field: 'listId', operator: 'equals', value: workId }]
 */
export function toFilter(conditions: DraftCondition[]): Array<{ field: string; operator: string; value?: string }> {
  return conditions.map(({ field, operator, value }) => (unary(operator) ? { field, operator } : { field, operator, value }));
}

export function EventTriggerFields({ catalog, event, filter, lists, routines, selfId, invalid, onChange }: {
  catalog: Catalog;
  event: string;
  filter: DraftCondition[];
  lists: TaskList[] | undefined;
  routines: Routine[] | undefined;
  /** The routine being edited – it cannot start on its own runs. */
  selfId?: string;
  invalid: Map<string | undefined, string>;
  onChange: (patch: { event?: string; filter?: DraftCondition[] }) => void;
}) {
  const domains = catalog.domains.filter((domain) => domain.enabled && (domain.triggers?.length ?? 0) > 0);
  const trigger = catalog.trigger(event);
  const domain = trigger?.domain.domain ?? '';
  const patch = (uid: string, change: Partial<DraftCondition>) => onChange({ filter: filter.map((condition) => (condition.uid === uid ? { ...condition, ...change } : condition)) });
  const add = () => onChange({ filter: [...filter, { uid: crypto.randomUUID(), field: trigger?.fields[0]?.name ?? '', operator: 'equals', value: '' }] });
  const eventProblem = invalid.get('field-event');

  return (
    <div className="event-trigger">
      <div className="inline-fields">
        <label className="field">
          <span>Area</span>
          <select value={domain} onChange={(change) => {
            const first = domains.find((candidate) => candidate.domain === change.target.value)?.triggers?.[0];
            onChange({ event: first?.type ?? '', filter: [] });
          }}>
            {!domain && <option value="">Choose…</option>}
            {domains.map((candidate) => <option key={candidate.domain} value={candidate.domain}>{candidate.name}</option>)}
          </select>
        </label>
        <label className="field event-select">
          <span>Event</span>
          <select id="field-event" value={event} className={eventProblem ? 'invalid' : ''} aria-invalid={eventProblem ? true : undefined}
            onChange={(change) => onChange({ event: change.target.value, filter: [] })}>
            {!trigger && <option value={event}>{event ? `Unknown event (${event})` : 'Choose an event…'}</option>}
            {trigger?.domain.triggers?.map((candidate) => <option key={candidate.type} value={candidate.type}>{candidate.label}</option>)}
          </select>
          {eventProblem && <small className="field-error">{eventProblem}</small>}
        </label>
      </div>
      {trigger && <small className="muted">{trigger.description}</small>}

      {trigger && (
        <fieldset className="filter-rows">
          <legend>Only when</legend>
          {filter.length === 0 && <p className="muted small">Every time it happens.</p>}
          {filter.map((condition, index) => {
            const picker = refPicker(trigger, condition.field);
            const problem = invalid.get(`field-filter-${condition.uid}`);
            const valueLabel = `Value of condition ${index + 1}`;
            return (
              <div key={condition.uid} className="filter-row">
                <select aria-label={`Field of condition ${index + 1}`} value={condition.field} onChange={(change) => patch(condition.uid, { field: change.target.value, value: '' })}>
                  {trigger.fields.map((field) => <option key={field.name} value={field.name}>{field.label}</option>)}
                </select>
                <select aria-label={`Comparison of condition ${index + 1}`} value={condition.operator} onChange={(change) => patch(condition.uid, { operator: change.target.value })}>
                  {FILTER_OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
                </select>
                {unary(condition.operator) ? <span className="filter-value" /> : picker === 'tasklist' ? (
                  <select id={`field-filter-${condition.uid}`} aria-label={valueLabel} value={condition.value} className={`filter-value ${problem ? 'invalid' : ''}`}
                    onChange={(change) => patch(condition.uid, { value: change.target.value })}>
                    <option value="">Choose a list…</option>
                    {lists?.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
                    {condition.value && lists && !lists.some((list) => list.id === condition.value) && <option value={condition.value}>Deleted list</option>}
                  </select>
                ) : picker === 'routine' ? (
                  <select id={`field-filter-${condition.uid}`} aria-label={valueLabel} value={condition.value} className={`filter-value ${problem ? 'invalid' : ''}`}
                    onChange={(change) => patch(condition.uid, { value: change.target.value })}>
                    <option value="">Choose a routine…</option>
                    {routines?.filter((routine) => routine.id !== selfId).map((routine) => <option key={routine.id} value={routine.id}>{routine.name}</option>)}
                    {condition.value && routines && !routines.some((routine) => routine.id === condition.value) && <option value={condition.value}>Deleted routine</option>}
                  </select>
                ) : (
                  <input id={`field-filter-${condition.uid}`} aria-label={valueLabel} value={condition.value} className={`filter-value ${problem ? 'invalid' : ''}`}
                    onChange={(change) => patch(condition.uid, { value: change.target.value })} />
                )}
                <IconButton icon="trash" label={`Remove condition ${index + 1}`} className="danger"
                  onClick={() => onChange({ filter: filter.filter((candidate) => candidate.uid !== condition.uid) })} />
                {problem && <small className="field-error span-all">{problem}</small>}
              </div>
            );
          })}
          <button type="button" className="btn ghost small" onClick={add} disabled={filter.length >= MAX_FILTER_CONDITIONS}>
            <Icon name="plus" size={14} /> Add a condition
          </button>
        </fieldset>
      )}
    </div>
  );
}
