import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromSpec, questionName, toSpec } from './questions.ts';

describe('"Ask when run?" questions in the editor', () => {
  it('names a question after its label', () => {
    assert.equal(questionName('Which city?'), 'whichCity');
    assert.equal(questionName('How many days?'), 'howManyDays');
    assert.equal(questionName('3 things'), 'q3Things');
    assert.equal(questionName('Zürich trip'), 'zurichTrip');
  });

  it('saves numbers as numbers, choices as options, and leaves out an empty default', () => {
    const base = { uid: 'u', name: 'days', label: 'How many days? ', type: 'number' as const, required: true, default: '3', options: '' };
    assert.deepEqual(toSpec(base), { name: 'days', label: 'How many days?', type: 'number', required: true, default: 3 });
    assert.deepEqual(toSpec({ ...base, name: 'city', type: 'choice', required: false, default: '', options: 'Bern, Basel,, Zurich' }), {
      name: 'city', label: 'How many days?', type: 'choice', options: [{ value: 'Bern', label: 'Bern' }, { value: 'Basel', label: 'Basel' }, { value: 'Zurich', label: 'Zurich' }],
    });
  });

  it('round-trips a saved question', () => {
    const spec = { name: 'city', label: 'Which city?', type: 'choice' as const, default: 'Bern', options: [{ value: 'Bern', label: 'Bern' }, { value: 'Basel', label: 'Basel' }] };
    assert.deepEqual(toSpec(fromSpec(spec, 'u')), spec);
  });
});
