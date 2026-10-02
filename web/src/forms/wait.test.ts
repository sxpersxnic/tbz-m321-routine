import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { actionSentence, formOf, setGeneratedForms } from '../action-forms.ts';
import type { CatalogDomain } from '../types.ts';
import { formsFromCatalog } from './generate.ts';

// the recorded catalog – flow.wait as the scripting manifest describes it
setGeneratedForms(formsFromCatalog(JSON.parse(readFileSync(new URL('./catalog.fixture.json', import.meta.url), 'utf8')) as CatalogDomain[]));
const words = (params: Record<string, unknown>) => actionSentence('flow.wait', params).map((part) => (typeof part === 'string' ? part : `[${part.token}]`)).join('');

describe('the Wait step (M3-08)', () => {
  it('reads "for" or "until", whichever is set, durations in words', () => {
    assert.equal(words({ for: 'PT1H' }), 'Wait for [1 hour]');
    assert.equal(words({ until: '17:00' }), 'Wait until [17:00]');
    assert.equal(words({ for: 'PT90M' }), 'Wait for [PT90M]');
  });

  it('offers common durations and a time', () => {
    const fields = formOf('flow.wait')?.fields ?? [];
    assert.deepEqual(fields.map((field) => [field.name, field.kind]), [['for', 'duration'], ['until', 'time']]);
    assert.ok(fields[0].options?.includes('P1W'));
  });
});
