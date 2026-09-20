import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_BACKOFF,
  PRIORITIES,
  STATUSES,
  TaskError,
  calculateBackoff,
  claimTask,
  createTask,
  failureTransition,
  recoverLease,
  requeueDeadTask,
  selectDueTasks,
  serializeError,
  successTransition
} from './js/queue-policy.js';

const fixedSequence = values => {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
};

describe('backoff', () => {
  it('uses equal jitter around exponential raw delay', () => {
    const rng = fixedSequence([0, 0.25, 1]);

    assert.deepEqual(calculateBackoff({ attempt: 1, rng }).delay, 0);
    assert.deepEqual(calculateBackoff({ attempt: 2, rng }).delay, 250);
    assert.deepEqual(calculateBackoff({ attempt: 4, rng }).delay, 4000);
  });

  it('caps exponential delay at maxDelay', () => {
    const result = calculateBackoff({
      attempt: 20,
      baseDelay: 1000,
      factor: 2,
      maxDelay: 8000,
      rng: () => 1
    });

    assert.equal(result.raw, 8000);
    assert.equal(result.delay, 8000);
  });
});

describe('priority scheduling', () => {
  it('selects due high priority tasks before older low priority tasks', () => {
    const now = 1000;
    const low = createTask({ id: 'low', type: 'demo', priority: PRIORITIES.LOW, now: 1 });
    const high = createTask({ id: 'high', type: 'demo', priority: PRIORITIES.HIGH, now: 2 });
    const waiting = createTask({ id: 'waiting', type: 'demo', priority: PRIORITIES.HIGH, now: 3 });
    waiting.runAfter = 2000;

    const selected = selectDueTasks([low, waiting, high], { now, limit: 2 });
    assert.deepEqual(selected.map(task => task.id), ['high', 'low']);
  });

  it('claims in one atomic state transition and increments attempts', () => {
    const task = createTask({ id: 'task', type: 'demo' });
    const claimed = claimTask(task, { now: 100, owner: 'worker-a' });

    assert.equal(claimed.status, STATUSES.RUNNING);
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.leaseOwner, 'worker-a');
    assert.equal(claimed.leaseUntil, 100 + DEFAULT_BACKOFF.leaseDuration);
  });
});

describe('dead letter decisions', () => {
  it('retries retryable failures with calculated backoff', () => {
    let task = createTask({ id: 'task', type: 'flaky', maxAttempts: 2 });
    task = claimTask(task, { owner: 'worker-a' });
    const transition = failureTransition(task, new Error('temporary'), {
      rng: () => 0.5
    });

    assert.equal(transition.retryable, true);
    assert.equal(transition.task.status, STATUSES.QUEUED);
    assert.equal(transition.task.attempts, 1);
    assert.equal(transition.delayMs, 250);
    assert.equal(transition.task.runAfter, transition.task.updatedAt + 250);
  });

  it('moves exhausted tasks to dead letter after final attempt', () => {
    let task = createTask({ id: 'task', type: 'flaky', maxAttempts: 2, now: 0 });
    task = claimTask(task, { now: 0, owner: 'worker-a' });
    task = failureTransition(task, new Error('first'), { now: 0, rng: () => 1 }).task;
    task = claimTask(task, { now: 500, owner: 'worker-b' });
    const transition = failureTransition(task, new Error('second'), { now: 500, rng: () => 1 });

    assert.equal(transition.retryable, false);
    assert.equal(transition.deadReason, 'max_attempts');
    assert.equal(transition.task.status, STATUSES.DEAD);
    assert.equal(transition.task.attempts, 2);
    assert.match(transition.task.errorChain.at(-1).error.message, /最大尝试次数/);
  });

  it('immediately dead letters non-retryable errors', () => {
    let task = createTask({ id: 'task', type: 'fatal' });
    task = claimTask(task, { owner: 'worker-a' });
    const transition = failureTransition(task, new TaskError('invalid', { nonRetryable: true }));

    assert.equal(transition.deadReason, 'non_retryable');
    assert.equal(transition.task.status, STATUSES.DEAD);
    assert.equal(transition.task.attempts, 1);
  });
});

describe('terminal, recovery and reentry', () => {
  it('stores success result and releases lease', () => {
    let task = claimTask(createTask({ id: 'task', type: 'demo' }), { owner: 'worker-a' });
    task = successTransition(task, { ok: true }, { now: 500 });

    assert.equal(task.status, STATUSES.SUCCEEDED);
    assert.deepEqual(task.result, { ok: true });
    assert.equal(task.completedAt, 500);
    assert.equal(task.leaseOwner, null);
  });

  it('requeues only expired running leases', () => {
    let task = claimTask(createTask({ id: 'task', type: 'slow' }), {
      now: 0,
      owner: 'worker-a',
      leaseDuration: 1000
    });
    assert.equal(recoverLease(task, { now: 999 }), task);

    task = recoverLease(task, { now: 1001 });
    assert.equal(task.status, STATUSES.QUEUED);
    assert.equal(task.leaseOwner, null);
    assert.equal(task.attempts, 1);
    assert.equal(task.lifecycle.at(-1).type, 'lease_recovered');
  });

  it('resets attempts when dead task re-enters but keeps audit chain', () => {
    let task = createTask({ id: 'task', type: 'flaky', maxAttempts: 1 });
    task = claimTask(task, { owner: 'worker-a' });
    task = failureTransition(task, new Error('failed')).task;
    assert.equal(task.status, STATUSES.DEAD);

    const requeued = requeueDeadTask(task, { now: 900 });
    assert.equal(requeued.status, STATUSES.QUEUED);
    assert.equal(requeued.attempts, 0);
    assert.equal(requeued.reentryCount, 1);
    assert.equal(requeued.errorChain.length, 1);
    assert.equal(requeued.lastError, null);
    assert.equal(requeued.lifecycle.at(-1).type, 'reentered_from_dead');
  });
});

describe('exception chain', () => {
  it('serializes nested Error cause and aggregate errors', () => {
    const root = new TypeError('socket reset');
    const network = new Error('network failed', { cause: root });
    const aggregate = new AggregateError([network], 'dependency failed');
    const serialized = serializeError(aggregate);

    assert.equal(serialized.name, 'AggregateError');
    assert.equal(serialized.errors[0].cause.name, 'TypeError');
    assert.match(serialized.errors[0].cause.message, /socket reset/);
  });

  it('serializes non-Error thrown values', () => {
    const serialized = serializeError({ code: 'WEIRD' });
    assert.equal(serialized.name, 'NonErrorThrow');
    assert.match(serialized.message, /WEIRD/);
  });

  it('serializes plain-object causes with structured fields', () => {
    const error = new Error('network failed');
    error.cause = {
      name: 'SocketError',
      message: 'ECONNRESET',
      code: 'ECONNRESET'
    };
    const serialized = serializeError(error);

    assert.equal(serialized.cause.name, 'SocketError');
    assert.equal(serialized.cause.code, 'ECONNRESET');
  });
});
