import assert from 'node:assert/strict';
import test from 'node:test';
import { NonRetryableError } from '../src/lib/errors.js';
import {
  STATUSES,
  claimTask,
  completeTask,
  createTask,
  recoverExpiredLease,
  requeueDeadTask,
  selectNextTask
} from '../src/lib/task.js';

test('selector honors due time, priority, and FIFO tie-break', () => {
  const now = 1000;
  const low = createTask({ id: 'low', priority: 1, type: 'success' });
  const high = createTask({ id: 'high', priority: 9, type: 'success' });
  const delayed = createTask({ id: 'delayed', priority: 10, delay: 100, type: 'success' });
  for (const task of [low, high, delayed]) {
    task.createdAt = now;
    task.availableAt = task.id === 'delayed' ? now + 100 : now;
  }

  assert.equal(selectNextTask([low, high, delayed], now).id, 'high');
  assert.equal(selectNextTask([low, high, delayed], now + 100).id, 'delayed');
});

test('retryable failure schedules a retry with the next attempt backoff', () => {
  const now = 1000;
  let task = createTask({ id: 'task', maxAttempts: 3, backoff: { baseDelay: 100, jitter: 0 } });
  task.availableAt = now;
  task = claimTask(task, { now, leaseId: 'lease-1', workerId: 'w1', leaseDuration: 1000 });
  const failed = completeTask(task, { now, leaseId: 'lease-1', error: new Error('503'), random: () => 0 });

  assert.equal(failed.task.status, STATUSES.RETRYING);
  assert.equal(failed.task.availableAt, now + 100);
  assert.equal(failed.task.leaseId, null);
  assert.equal(failed.task.errorChain[0].error.message, '503');
});

test('final retryable failure enters dead-letter queue', () => {
  const now = 1000;
  let task = createTask({ id: 'task', maxAttempts: 2, backoff: { jitter: 0 } });
  task.availableAt = now;
  task = claimTask(task, { now, leaseId: 'a', workerId: 'w1', leaseDuration: 1000 });
  task = completeTask(task, { now, leaseId: 'a', error: new Error('x'), random: () => 0 }).task;
  task = claimTask(task, { now: now + 500, leaseId: 'b', workerId: 'w2', leaseDuration: 1000 });
  const result = completeTask(task, { now: now + 600, leaseId: 'b', error: new Error('y') });

  assert.equal(result.task.status, STATUSES.DEAD);
  assert.equal(result.task.deadReason, 'max_attempts_reached');
  assert.equal(result.task.errorChain.length, 2);
});

test('terminal error bypasses remaining attempts', () => {
  const now = 1000;
  let task = createTask({ id: 'task', maxAttempts: 10 });
  task.availableAt = now;
  task = claimTask(task, { now, leaseId: 'lease', workerId: 'w1', leaseDuration: 1000 });
  const result = completeTask(task, {
    now,
    leaseId: 'lease',
    error: new NonRetryableError('bad request', { cause: new Error('invalid email') })
  });

  assert.equal(result.task.status, STATUSES.DEAD);
  assert.equal(result.task.deadReason, 'terminal_error');
  assert.equal(result.task.lastError.cause.message, 'invalid email');
});

test('lease fencing rejects stale worker completion', () => {
  const now = 1000;
  let task = createTask({ id: 'task' });
  task.availableAt = now;
  task = claimTask(task, { now, leaseId: 'old', workerId: 'w1', leaseDuration: 1000 });
  const stale = completeTask(task, { now: now + 100, leaseId: 'new', result: 'bad' });
  assert.equal(stale.stale, true);
});

test('expired lease retries crashed work and then dead-letters it', () => {
  const now = 1000;
  let task = createTask({ id: 'task', maxAttempts: 1, backoff: { baseDelay: 50, jitter: 0 } });
  task.availableAt = now;
  task = claimTask(task, { now, leaseId: 'lease', workerId: 'w1', leaseDuration: 100 });
  const recovered = recoverExpiredLease(task, { now: now + 200, random: () => 0 });

  assert.equal(recovered.task.status, STATUSES.DEAD);
  assert.equal(recovered.task.deadReason, 'lease_expired');
});

test('dead-letter requeue resets attempts and preserves replay count', () => {
  let task = createTask({ id: 'task', maxAttempts: 2 });
  task = { ...task, status: STATUSES.DEAD, attempts: 2, deadAt: 1000, completedAt: 1000 };
  const requeued = requeueDeadTask(task, { now: 2000 });

  assert.equal(requeued.status, STATUSES.QUEUED);
  assert.equal(requeued.attempts, 0);
  assert.equal(requeued.requeueCount, 1);
  assert.equal(requeued.availableAt, 2000);
});
