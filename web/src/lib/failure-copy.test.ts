import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { setGeneratedForms } from '../action-forms.ts';
import { formsFromCatalog } from '../forms/generate.ts';
import type { CatalogDomain, ErrorCode } from '../types.ts';
import { ERROR_CODES, FAILURE_ACTION_LABELS, failureCopy, failureField, failureLine, type FailedStep } from './failure-copy.ts';

// step forms come from the catalog – the live one, recorded (forms/catalog.fixture.json)
setGeneratedForms(formsFromCatalog(JSON.parse(readFileSync(new URL('../forms/catalog.fixture.json', import.meta.url), 'utf8')) as CatalogDomain[]));

/** One failed step per code, as the services report it – the fixture every code is rendered from. */
const FIXTURES: Record<ErrorCode, { step: FailedStep; sentence: string; action: string }> = {
  NOT_FOUND: {
    step: { type: 'http.request', params: { url: 'http://mock-external:8090/status/404' }, error: 'mock-external:8090 answered 404 Not Found' },
    sentence: "The website said this page doesn't exist. The address may have changed.",
    action: 'Edit step',
  },
  UNAUTHORIZED: { step: { type: 'http.request', params: {}, error: 'api answered 401' }, sentence: "The service didn't accept the key. It may have expired.", action: 'Open connection' },
  FORBIDDEN_HOST: { step: { type: 'http.request', params: {}, error: 'host "routine-db" is not on the allow-list' }, sentence: "Routine isn't allowed to call this address.", action: 'Edit step' },
  TIMEOUT: { step: { type: 'weather.get', params: {}, error: 'request failed: timeout' }, sentence: 'The service took too long to answer.', action: 'Retry from here' },
  UNREACHABLE: { step: { type: 'weather.get', params: {}, error: 'ECONNREFUSED' }, sentence: "The service couldn't be reached.", action: 'Retry from here' },
  RATE_LIMITED: { step: { type: 'http.request', params: {}, error: 'answered 429' }, sentence: 'The service asked Routine to slow down.', action: 'Retry from here' },
  INVALID_PARAMS: { step: { type: 'weather.get', params: {}, error: 'param "city" is required' }, sentence: 'This step is missing something: City.', action: 'Edit step' },
  TEMPLATE_ERROR: {
    step: { type: 'notification.send', params: {}, error: 'template reference "{{actions.weather.summary}}" could not be resolved' },
    sentence: "A value this step uses wasn't there: Forecast (Weather).",
    action: 'Edit step',
  },
  NOT_AVAILABLE: { step: { type: 'task.create', params: {}, error: 'task-service cannot handle action type task.create' }, sentence: "Tasks isn't turned on or doesn't know this step any more.", action: 'Open settings' },
  REFERENCE_GONE: { step: { type: 'routine.run', params: {}, error: 'the routine to run does not exist (any more)' }, sentence: 'The routine this step uses was deleted.', action: 'Edit step' },
  SUBROUTINE_FAILED: { step: { type: 'routine.run', params: { routineName: 'Backup' }, error: 'Routine "Backup": boom' }, sentence: 'The routine "Backup" it called failed.', action: 'Open that run' },
  AWAIT_EXPIRED: { step: { type: 'task.await', params: {}, error: 'expired' }, sentence: 'Nobody did this in time.', action: 'Retry from here' },
  QUOTA_EXCEEDED: { step: { type: 'ai.ask', params: {}, error: 'quota' }, sentence: "This month's AI allowance is used up.", action: 'Open settings' },
  AI_REFUSED: { step: { type: 'ai.ask', params: {}, error: 'refused' }, sentence: 'The AI step declined this request.', action: 'Edit step' },
  INPUT_TOO_LARGE: {
    step: { type: 'weather.get', params: {}, error: '"repeat for each" is limited to 50 items, the list has 80' },
    sentence: 'This step got more than it can handle: "repeat for each" is limited to 50 items, the list has 80.',
    action: 'Edit step',
  },
  CONFLICT: { step: { type: 'task.complete', params: {}, error: 'task is closed' }, sentence: "Something changed in the meantime, so this step couldn't go ahead.", action: 'Retry from here' },
  CANCELLED: { step: { type: 'weather.get', params: {}, error: 'cancelled' }, sentence: 'You cancelled this run.', action: 'Retry from here' },
  INTERNAL: { step: { type: 'weather.get', params: {}, error: 'TypeError: x is undefined' }, sentence: 'Something went wrong on our side.', action: 'Retry from here' },
};

describe('failure copy (02-experience §8)', () => {
  it('renders every error code from its fixture', () => {
    assert.deepEqual(Object.keys(FIXTURES).sort(), [...ERROR_CODES].sort(), 'a fixture per code');
    for (const code of ERROR_CODES) {
      const copy = failureCopy(code, FIXTURES[code].step, { weather: 'weather.get' });
      assert.equal(copy?.sentence, FIXTURES[code].sentence, code);
      assert.equal(copy && FAILURE_ACTION_LABELS[copy.action], FIXTURES[code].action, code);
      assert.doesNotMatch(failureLine(code) ?? '', /[{}]/, `${code}: the short line has no placeholders`);
    }
  });

  it('keeps the raw error for failures without a code (runs from before v2)', () => {
    assert.equal(failureCopy(null, FIXTURES.NOT_FOUND.step), null);
    assert.equal(failureLine(undefined), null);
  });

  it('falls back to INTERNAL for a code this client does not know yet', () => {
    assert.equal(failureCopy('SOMETHING_NEW' as ErrorCode, FIXTURES.INTERNAL.step)?.sentence, 'Something went wrong on our side.');
  });

  it('uses the message itself when it names no param', () => {
    const step = { type: 'email.send', params: {}, error: '"ada@" is not an e-mail address' };
    assert.equal(failureCopy('INVALID_PARAMS', step)?.sentence, 'This step is missing something: "ada@" is not an e-mail address.');
  });

  it('names the field "Edit step" should focus', () => {
    assert.equal(failureField('INVALID_PARAMS', FIXTURES.INVALID_PARAMS.step), 'city');
    assert.equal(failureField('NOT_FOUND', FIXTURES.NOT_FOUND.step), 'url');
    assert.equal(failureField('TIMEOUT', FIXTURES.TIMEOUT.step), undefined);
  });
});
