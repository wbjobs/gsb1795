import assert from 'node:assert/strict';
import test from 'node:test';
import { errorCauseChain, normalizeError } from '../src/lib/errors.js';

test('normalizes nested exception cause chains', () => {
  const normalized = normalizeError(
    new Error('outer', {
      cause: new Error('middle', { cause: new Error('inner') })
    })
  );

  assert.equal(normalized.message, 'outer');
  assert.equal(normalized.cause.message, 'middle');
  assert.equal(normalized.cause.cause.message, 'inner');
  assert.deepEqual(errorCauseChain(normalized), ['Error: outer', 'Error: middle', 'Error: inner']);
});

test('marks terminal errors non-retryable', () => {
  const normalized = normalizeError({ name: 'ValidationError', message: 'bad', retryable: false });
  assert.equal(normalized.retryable, false);
});
