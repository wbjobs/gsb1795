import { calculateBackoff, deadLetterDecision, normalizeBackoff } from './retry.js';
import { normalizeError } from './errors.js';

export const STATUSES = Object.freeze({
  QUEUED: 'queued',
  RETRYING: 'retrying',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  DEAD: 'dead'
});

export function createTask(input = {}) {
  const now = Date.now();
  const maxAttempts = Math.max(1, Math.trunc(Number(input.maxAttempts ?? 5)));
  const delay = Math.max(0, Number(input.delay ?? 0));

  return {
    id: input.id || createId(),
    type: String(input.type || 'flaky'),
    name: input.name ? String(input.name) : String(input.type || 'flaky'),
    payload: structuredCloneValue(input.payload ?? {}),
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
    maxAttempts,
    attempts: 0,
    status: STATUSES.QUEUED,
    availableAt: now + delay,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    deadAt: null,
    result: null,
    lastError: null,
    errorChain: [],
    backoff: normalizeBackoff(input.backoff),
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    requeueCount: 0,
    deadReason: null
  };
}

export function selectNextTask(tasks, now = Date.now()) {
  return tasks
    .filter((task) => isScheduled(task) && task.availableAt <= now)
    .sort(compareTaskPriority)[0] || null;
}

export function isScheduled(task) {
  return task.status === STATUSES.QUEUED || task.status === STATUSES.RETRYING;
}

export function compareTaskPriority(left, right) {
  if (right.priority !== left.priority) return right.priority - left.priority;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.id.localeCompare(right.id);
}

export function claimTask(task, options) {
  if (!isScheduled(task) || task.availableAt > options.now) {
    return null;
  }

  return {
    ...task,
    payload: structuredCloneValue(task.payload),
    attempts: task.attempts + 1,
    status: STATUSES.RUNNING,
    startedAt: task.startedAt ?? options.now,
    updatedAt: options.now,
    leaseId: options.leaseId,
    leaseOwner: options.workerId,
    leaseExpiresAt: options.now + options.leaseDuration
  };
}

export function completeTask(task, options) {
  const { now, leaseId, result, error, random = Math.random } = options;
  if (task.status !== STATUSES.RUNNING || task.leaseId !== leaseId) {
    return { stale: true, task };
  }

  const base = {
    ...task,
    updatedAt: now,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    availableAt: null
  };

  if (!error) {
    return {
      stale: false,
      task: {
        ...base,
        status: STATUSES.SUCCEEDED,
        completedAt: now,
        result: structuredCloneValue(result ?? null),
        lastError: null,
        deadReason: null
      }
    };
  }

  const normalizedError = normalizeError(error);
  const chainEntry = { attempt: task.attempts, at: now, error: normalizedError };
  const decision = deadLetterDecision(task.attempts, task.maxAttempts, normalizedError);

  if (decision.dead) {
    return {
      stale: false,
      reason: decision.reason,
      task: {
        ...base,
        status: STATUSES.DEAD,
        deadAt: now,
        completedAt: now,
        lastError: normalizedError,
        deadReason: decision.reason,
        errorChain: [...task.errorChain, chainEntry]
      }
    };
  }

  const retryDelay = calculateBackoff(task.attempts, task.backoff, random);
  return {
    stale: false,
    reason: 'retry_scheduled',
    task: {
      ...base,
      status: STATUSES.RETRYING,
      availableAt: now + retryDelay,
      lastError: normalizedError,
      errorChain: [...task.errorChain, chainEntry]
    }
  };
}

export function renewLease(task, options) {
  if (task.status !== STATUSES.RUNNING || task.leaseId !== options.leaseId) {
    return null;
  }
  return {
    ...task,
    leaseExpiresAt: options.now + options.leaseDuration,
    updatedAt: options.now
  };
}

export function recoverExpiredLease(task, options) {
  if (task.status !== STATUSES.RUNNING || task.leaseExpiresAt > options.now) {
    return null;
  }

  const leaseError = normalizeError({
    name: 'LeaseExpiredError',
    message: `Worker ${task.leaseOwner || 'unknown'} lost its lease`,
    retryable: true
  });
  const chainEntry = { attempt: task.attempts, at: options.now, error: leaseError };
  const decision = deadLetterDecision(task.attempts, task.maxAttempts, leaseError);
  const base = {
    ...task,
    updatedAt: options.now,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: leaseError,
    errorChain: [...task.errorChain, chainEntry]
  };

  if (decision.dead) {
    return {
      reason: 'lease_expired',
      task: {
        ...base,
        status: STATUSES.DEAD,
        deadAt: options.now,
        completedAt: options.now,
        deadReason: 'lease_expired',
        availableAt: null
      }
    };
  }

  const retryDelay = calculateBackoff(task.attempts, task.backoff, options.random ?? Math.random);
  return {
    reason: 'lease_retry_scheduled',
    task: {
      ...base,
      status: STATUSES.RETRYING,
      availableAt: options.now + retryDelay
    }
  };
}

export function requeueDeadTask(task, options) {
  if (task.status !== STATUSES.DEAD) {
    throw new Error('Only dead-letter tasks can be requeued');
  }

  const now = options.now;
  return {
    ...task,
    status: STATUSES.QUEUED,
    attempts: 0,
    availableAt: now + Math.max(0, Number(options.delay ?? 0)),
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    deadAt: null,
    result: null,
    lastError: null,
    deadReason: null,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    requeueCount: task.requeueCount + 1,
    backoff: normalizeBackoff(options.backoff ?? task.backoff)
  };
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function structuredCloneValue(value) {
  if (globalThis.structuredClone) return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
