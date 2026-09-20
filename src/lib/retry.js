export const DEFAULT_BACKOFF = Object.freeze({
  baseDelay: 500,
  factor: 2,
  maxDelay: 15_000,
  jitter: 0.2
});

export function normalizeBackoff(config = {}) {
  return {
    baseDelay: positive(config.baseDelay ?? DEFAULT_BACKOFF.baseDelay, 'baseDelay'),
    factor: positive(config.factor ?? DEFAULT_BACKOFF.factor, 'factor'),
    maxDelay: positive(config.maxDelay ?? DEFAULT_BACKOFF.maxDelay, 'maxDelay'),
    jitter: clamp(Number(config.jitter ?? DEFAULT_BACKOFF.jitter), 0, 1)
  };
}

export function calculateBackoff(attempt, config = {}, random = Math.random) {
  const backoff = normalizeBackoff(config);
  const failedAttempt = Math.max(1, Math.trunc(attempt));
  const rawDelay = Math.min(
    backoff.maxDelay,
    backoff.baseDelay * backoff.factor ** (failedAttempt - 1)
  );
  const jitterMultiplier = 1 - backoff.jitter + 2 * backoff.jitter * random();
  return Math.max(0, Math.min(backoff.maxDelay, Math.round(rawDelay * jitterMultiplier)));
}

export function isTerminalError(error) {
  return Boolean(
    error &&
      (error.retryable === false ||
        error.terminal === true ||
        error.fatal === true ||
        error.name === 'NonRetryableError')
  );
}

export function deadLetterDecision(attempt, maxAttempts, error) {
  if (isTerminalError(error)) {
    return { dead: true, reason: 'terminal_error' };
  }
  if (attempt >= maxAttempts) {
    return { dead: true, reason: 'max_attempts_reached' };
  }
  return { dead: false, reason: null };
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return number;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
