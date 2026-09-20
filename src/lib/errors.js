export class NonRetryableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'NonRetryableError';
    this.retryable = false;
  }
}

export function normalizeError(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return {
      name: 'Error',
      message: 'Task failed without an error',
      retryable: true
    };
  }

  if (typeof value !== 'object') {
    return {
      name: 'Error',
      message: String(value),
      retryable: true
    };
  }

  if (seen.has(value)) {
    return { name: 'Error', message: '[Circular error cause]' };
  }
  seen.add(value);

  const error = {
    name: value.name || 'Error',
    message: value.message || String(value),
    retryable: value.retryable !== false
  };

  if (value.code !== undefined) error.code = value.code;
  if (value.stack) error.stack = String(value.stack);
  if (value.terminal === true || value.fatal === true) error.terminal = true;

  if (value.cause !== undefined) {
    error.cause = normalizeError(value.cause, seen);
  }

  if (Array.isArray(value.errors)) {
    error.errors = value.errors.slice(0, 5).map((item) => normalizeError(item, seen));
  }

  return error;
}

export function errorCauseChain(error, chain = []) {
  if (!error) return chain;
  chain.push(`${error.name}: ${error.message}`);
  return error.cause ? errorCauseChain(error.cause, chain) : chain;
}
