import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { healthLine } from './health.ts';

const health = (runs30d: number, failures30d: number, consecutiveFailures = 0) => ({ runs30d, failures30d, consecutiveFailures, lastSuccessAt: null, lastFailureAt: null });

describe('health line', () => {
  it('is quiet while it works, and says nothing before the first run', () => {
    assert.deepEqual(healthLine(health(28, 0)), { text: '28 of 28 this month', failing: false });
    assert.deepEqual(healthLine(health(28, 1, 1)), { text: '27 of 28 this month', failing: false }, 'one failure is not a pattern');
    assert.equal(healthLine(health(0, 0)), null);
    assert.equal(healthLine(undefined), null);
  });

  it('speaks up once runs keep failing', () => {
    assert.deepEqual(healthLine(health(5, 3, 3)), { text: 'Failed the last 3 runs', failing: true });
  });
});
