import { NonRetryableError } from '../lib/errors.js';

export const LEASE_DURATION = 2500;

export async function executeTask(task) {
  const duration = Number(task.payload?.duration ?? 700);
  await delay(duration);

  switch (task.type) {
    case 'success':
      return { completedAt: new Date().toISOString(), value: task.payload.value ?? 'ok' };

    case 'flaky': {
      const failUntil = Number(task.payload?.failUntil ?? 2);
      if (task.attempts <= failUntil) {
        throw new Error(`Upstream returned HTTP 503 on attempt ${task.attempts}`, {
          cause: new Error('socket hang up')
        });
      }
      return { recovered: true, attempts: task.attempts };
    }

    case 'terminal':
      throw new NonRetryableError('Payload failed validation', {
        cause: new Error(`missing field: ${task.payload?.field ?? 'email'}`)
      });

    case 'chained':
      throw new Error('Payment gateway rejected request', {
        cause: new Error('authorization failed', {
          cause: new Error('card declined: insufficient funds')
        })
      });

    case 'slow':
      return { waited: duration, leaseRenewed: true };

    case 'abandoned':
      return { staleWorkerShouldIgnore: true };

    case 'crashed':
      return new Promise(() => {});

    default:
      throw new Error(`Unknown task type: ${task.type}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
