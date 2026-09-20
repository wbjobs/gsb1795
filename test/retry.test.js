import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BACKOFF,
  calculateBackoff,
  deadLetterDecision,
  isTerminalError
} from '../src/lib/retry.js';

test('exponential backoff increases with equal jitter', () => {
  const first = calculateBackoff(1, { jitter: 0 }, () => 0);
  const second = calculateBackoff(2, { jitter: 0 }, () => 0);
  const third = calculateBackoff(3, { jitter: 0 }, () => 0);

  assert.equal(first, DEFAULT_BACKOFF.baseDelay);
  assert.equal(second, DEFAULT_BACKOFF.baseDelay * 2);
  assert.equal(third, DEFAULT_BACKOFF.baseDelay * 4);
});

test('backoff applies bounded jitter and maximum delay', () => {
  assert.equal(calculateBackoff(1, { baseDelay: 1000, jitter: 0.2 }, () => 0), 800);
  assert.equal(calculateBackoff(1, { baseDelay: 1000, jitter: 0.2 }, () => 1), 1200);
  assert.equal(calculateBackoff(20, { baseDelay: 100, factor: 10, maxDelay: 500, jitter: 0 }, () => 0), 500);
});

test('dead-letter decision recognizes terminal errors and exhausted attempts', () => {
  assert.deepEqual(deadLetterDecision(1, 3, { retryable: false }), {
    dead: true,
    reason: 'terminal_error'
  });
  assert.deepEqual(deadLetterDecision(3, 3, new Error('boom')), {
    dead: true,
    reason: 'max_attempts_reached'
  });
  assert.deepEqual(deadLetterDecision(2, 3, new Error('boom')), {
    dead: false,
    reason: null
  });
});

test('terminal errors are detected explicitly', () => {
  assert.equal(isTerminalError({ retryable: false }), true);
  assert.equal(isTerminalError({ fatal: true }), true);
  assert.equal(isTerminalError({ name: 'NonRetryableError' }), true);
  assert.equal(isTerminalError(new Error('retryable')), false);
});
