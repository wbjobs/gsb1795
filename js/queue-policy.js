export const STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  DEAD: 'dead'
});

export const PRIORITIES = Object.freeze({
  HIGH: 0,
  NORMAL: 1,
  LOW: 2
});

export const DEFAULT_BACKOFF = Object.freeze({
  baseDelay: 500,
  factor: 2,
  maxDelay: 8000,
  leaseDuration: 15_000
});

export class TaskError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = options.name || 'TaskError';
    if (options.nonRetryable) this.nonRetryable = true;
    if (options.retryable === false) this.retryable = false;
    if (options.code) this.code = options.code;
  }
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function calculateBackoff({
  attempt,
  baseDelay = DEFAULT_BACKOFF.baseDelay,
  factor = DEFAULT_BACKOFF.factor,
  maxDelay = DEFAULT_BACKOFF.maxDelay,
  rng = Math.random
} = {}) {
  const safeAttempt = Math.max(1, Math.trunc(attempt || 1));
  const raw = Math.min(maxDelay, baseDelay * (factor ** (safeAttempt - 1)));
  const jitter = clamp(rng(), 0, 1);
  return {
    raw: Math.round(raw),
    jitter,
    delay: Math.round(raw * jitter)
  };
}

export function createTask({
  id,
  type,
  payload = {},
  priority = PRIORITIES.NORMAL,
  maxAttempts = 5,
  now = Date.now()
} = {}) {
  if (!type) throw new TypeError('Task type is required');
  const resolvedId = id || globalThis.crypto?.randomUUID?.();
  if (!resolvedId) throw new TypeError('Task id is required when crypto.randomUUID is unavailable');

  return {
    schemaVersion: 1,
    id: resolvedId,
    type,
    payload,
    priority: clamp(Number(priority) || PRIORITIES.NORMAL, PRIORITIES.HIGH, PRIORITIES.LOW),
    maxAttempts: clamp(Number.parseInt(maxAttempts, 10) || 5, 1, 20),
    attempts: 0,
    status: STATUSES.QUEUED,
    runAfter: 0,
    leaseOwner: null,
    leaseUntil: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    result: null,
    lastError: null,
    errorChain: [],
    lifecycle: [{ type: 'created', at: now }],
    deadReason: null,
    reentryCount: 0,
    lastBackoffMs: null,
    lastFailureAt: null
  };
}

export function claimTask(task, {
  now = Date.now(),
  owner,
  leaseDuration = DEFAULT_BACKOFF.leaseDuration
} = {}) {
  if (!owner) throw new TypeError('Lease owner is required');
  if (task.status !== STATUSES.QUEUED || task.runAfter > now) return task;

  return {
    ...task,
    status: STATUSES.RUNNING,
    attempts: task.attempts + 1,
    leaseOwner: owner,
    leaseUntil: now + leaseDuration,
    startedAt: now,
    updatedAt: now
  };
}

export function compareDueTasks(left, right) {
  return (left.priority - right.priority)
    || (left.runAfter - right.runAfter)
    || (left.createdAt - right.createdAt)
    || left.id.localeCompare(right.id);
}

export function selectDueTasks(tasks, {
  now = Date.now(),
  limit = Number.POSITIVE_INFINITY,
  excludeIds = new Set()
} = {}) {
  return tasks
    .filter(task => task.status === STATUSES.QUEUED
      && task.runAfter <= now
      && !excludeIds.has(task.id))
    .sort(compareDueTasks)
    .slice(0, limit);
}

export function isNonRetryableError(error) {
  return Boolean(error
    && (error.nonRetryable === true
      || error.retryable === false
      || error.name === 'NonRetryableError'));
}

function normalizeThrownValue(value) {
  if (value instanceof Error) return value;
  const error = new Error(typeof value === 'string' ? value : safeStringify(value));
  error.name = 'NonErrorThrow';
  return error;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function serializeError(value, depth = 0, seen = new WeakSet()) {
  if (depth > 8) return { name: 'Error', message: '错误链超过最大深度' };
  if (depth > 0 && value && typeof value === 'object' && !(value instanceof Error)) {
    const serializedPlainObject = {
      name: value.name || 'PlainCause',
      message: value.message || safeStringify(value)
    };
    for (const key of ['code', 'status', 'statusCode']) {
      if (value[key] !== undefined) serializedPlainObject[key] = value[key];
    }
    if (value.cause !== undefined && value.cause !== null) {
      serializedPlainObject.cause = serializeError(value.cause, depth + 1, seen);
    }
    return serializedPlainObject;
  }
  if (!(value instanceof Error)) {
    return {
      name: 'NonErrorThrow',
      message: value === undefined ? 'undefined' : safeStringify(value)
    };
  }

  if (seen.has(value)) return { name: value.name || 'Error', message: '<circular cause>' };
  seen.add(value);

  const serialized = {
    name: value.name || 'Error',
    message: value.message,
    stack: value.stack?.split('\n').slice(0, 6),
    nonRetryable: isNonRetryableError(value)
  };

  for (const key of ['code', 'status', 'statusCode']) {
    if (value[key] !== undefined) serialized[key] = value[key];
  }

  if (value.cause !== undefined && value.cause !== null) {
    serialized.cause = serializeError(value.cause, depth + 1, seen);
  }
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    serialized.errors = value.errors
      .slice(0, 5)
      .map(error => serializeError(error, depth + 1, seen));
  }

  return serialized;
}

function appendLifecycle(task, event, now) {
  return [...task.lifecycle, { ...event, at: now }];
}

export function failureTransition(task, rawError, {
  now = Date.now(),
  backoff = DEFAULT_BACKOFF,
  rng = Math.random
} = {}) {
  const cause = normalizeThrownValue(rawError);
  const nonRetryable = isNonRetryableError(cause);
  const attemptsExhausted = task.attempts >= task.maxAttempts;
  const attemptError = new TaskError(
    `第 ${task.attempts}/${task.maxAttempts} 次执行失败：${cause.message}`,
    { cause, name: 'TaskAttemptError' }
  );

  let outerError = attemptError;
  let deadReason = null;
  if (nonRetryable) {
    deadReason = 'non_retryable';
    outerError = new TaskError('任务被判定为不可重试，直接进入死信', {
      cause: attemptError,
      name: 'DeadLetteredError',
      nonRetryable: true
    });
  } else if (attemptsExhausted) {
    deadReason = 'max_attempts';
    outerError = new TaskError(`已达到最大尝试次数 ${task.maxAttempts}`, {
      cause: attemptError,
      name: 'RetriesExhaustedError',
      nonRetryable: true
    });
  }

  const failure = {
    at: now,
    attempt: task.attempts,
    retryable: !deadReason,
    deadReason,
    error: serializeError(outerError)
  };

  const next = {
    ...task,
    updatedAt: now,
    leaseOwner: null,
    leaseUntil: null,
    startedAt: null,
    lastFailureAt: now,
    lastError: outerError.message,
    errorChain: [...task.errorChain, failure]
  };

  if (deadReason) {
    return {
      task: {
        ...next,
        status: STATUSES.DEAD,
        runAfter: null,
        completedAt: now,
        deadReason
      },
      retryable: false,
      deadReason,
      delayMs: 0
    };
  }

  const { delay } = calculateBackoff({ attempt: task.attempts, ...backoff, rng });
  return {
    task: {
      ...next,
      status: STATUSES.QUEUED,
      runAfter: now + delay,
      lastBackoffMs: delay
    },
    retryable: true,
    deadReason: null,
    delayMs: delay
  };
}

export function successTransition(task, result, { now = Date.now() } = {}) {
  return {
    ...task,
    status: STATUSES.SUCCEEDED,
    result: result === undefined ? null : result,
    runAfter: null,
    leaseOwner: null,
    leaseUntil: null,
    completedAt: now,
    updatedAt: now,
    lastError: null,
    deadReason: null
  };
}

export function requeueDeadTask(task, { now = Date.now() } = {}) {
  if (task.status !== STATUSES.DEAD) return task;

  return {
    ...task,
    status: STATUSES.QUEUED,
    attempts: 0,
    runAfter: now,
    leaseOwner: null,
    leaseUntil: null,
    startedAt: null,
    completedAt: null,
    result: null,
    lastError: null,
    deadReason: null,
    lastBackoffMs: null,
    lastFailureAt: null,
    reentryCount: task.reentryCount + 1,
    updatedAt: now,
    lifecycle: appendLifecycle(task, { type: 'reentered_from_dead' }, now)
  };
}

export function recoverLease(task, { now = Date.now() } = {}) {
  if (task.status !== STATUSES.RUNNING || (task.leaseUntil || 0) > now) return task;

  return {
    ...task,
    status: STATUSES.QUEUED,
    runAfter: now,
    leaseOwner: null,
    leaseUntil: null,
    startedAt: null,
    updatedAt: now,
    lifecycle: appendLifecycle(task, {
      type: 'lease_recovered',
      previousOwner: task.leaseOwner,
      attempt: task.attempts
    }, now)
  };
}
