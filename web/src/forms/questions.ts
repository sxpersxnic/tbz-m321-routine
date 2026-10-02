import type { RunInputSpec } from '../types.ts';

/** A question ("Ask when run?") as the editor holds it: everything as text until saved. */
export interface DraftQuestion {
  uid: string;
  name: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'choice';
  required: boolean;
  /** '' = no default. */
  default: string;
  /** Choices, one per comma: "Bern, Basel, Zurich". */
  options: string;
}

export const QUESTION_TYPES: Array<{ value: DraftQuestion['type']; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'choice', label: 'Choice' },
];

/** "Which city?" → `whichCity` – a name {{input.<name>}} can use. */
export function questionName(label: string): string {
  const words = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const name = words.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())).join('');
  return /^[a-z]/.test(name) ? name.slice(0, 40) : `q${name}`.slice(0, 40);
}

export function fromSpec(spec: RunInputSpec, uid: string): DraftQuestion {
  return {
    uid,
    name: spec.name,
    label: spec.label,
    type: spec.type === 'ref' ? 'text' : spec.type,
    required: spec.required === true,
    default: spec.default === undefined || spec.default === null ? '' : String(spec.default),
    options: (spec.options ?? []).map((option) => option.label).join(', '),
  };
}

export function toSpec(question: DraftQuestion): RunInputSpec {
  const options = question.options.split(',').map((option) => option.trim()).filter(Boolean);
  const fallback = question.default.trim();
  return {
    name: question.name.trim(),
    label: question.label.trim(),
    type: question.type,
    ...(question.required && { required: true }),
    ...(fallback !== '' && { default: question.type === 'number' && Number.isFinite(Number(fallback)) ? Number(fallback) : fallback }),
    ...(question.type === 'choice' && { options: options.map((option) => ({ value: option, label: option })) }),
  };
}
