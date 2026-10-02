import { useId } from 'react';
import { dateMode, type DateMode } from './dates.ts';

const SEGMENTS: Array<{ mode: DateMode; label: string }> = [
  { mode: 'today', label: 'Today' },
  { mode: 'tomorrow', label: 'Tomorrow' },
  { mode: 'days', label: 'In days' },
  { mode: 'date', label: 'Date' },
];

function localToday(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** A date param (07 §5.1): *Today · Tomorrow · In N days · Date*. */
export function DateInput({ id, label, value, required, onChange }: { id: string; label: string; value: string; required?: boolean; onChange: (next: string) => void }) {
  const { mode, days, date } = dateMode(value);
  const daysId = useId();
  const choose = (next: DateMode) => {
    if (next === mode && !required) return onChange(''); // tapping the chosen one again clears an optional date
    if (next === 'today') onChange('+0d');
    else if (next === 'tomorrow') onChange('+1d');
    else if (next === 'days') onChange(`+${days}d`);
    else if (next === 'date') onChange(date || localToday());
  };
  return (
    <div className="date-input">
      <div className="segmented" role="radiogroup" aria-label={label} id={id} tabIndex={-1}>
        {SEGMENTS.map((segment) => (
          <button key={segment.mode} type="button" role="radio" aria-checked={mode === segment.mode} className={mode === segment.mode ? 'active' : ''} onClick={() => choose(segment.mode)}>
            {segment.label}
          </button>
        ))}
      </div>
      {mode === 'days' && (
        <input id={daysId} type="number" inputMode="numeric" min={2} aria-label={`${label}: days from the run`} value={days}
          onChange={(event) => onChange(`+${Math.max(2, Math.floor(Number(event.target.value) || 2))}d`)} />
      )}
      {mode === 'date' && <input type="date" aria-label={label} value={date} onChange={(event) => onChange(event.target.value)} />}
      {mode === 'custom' && <input type="text" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />}
    </div>
  );
}
