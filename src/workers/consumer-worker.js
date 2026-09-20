import { TaskStore } from '../lib/storage.js';
import { LEASE_DURATION, executeTask } from './task-handlers.js';

const workerId = `worker-${Math.random().toString(36).slice(2, 8)}`;
const store = new TaskStore();
let currentRun = null;

postMessage({
  type: 'worker_ready',
  workerId,
  at: Date.now()
});

store
  .open()
  .then(() => {
    postMessage({ type: 'worker_started', workerId, at: Date.now() });
    schedulePoll(0);
  })
  .catch((error) => postMessage({ type: 'worker_error', workerId, error: String(error.stack || error) }));

function schedulePoll(delayMs = 200) {
  setTimeout(poll, delayMs);
}

async function poll() {
  if (currentRun) return;
  const runToken = {};
  currentRun = runToken;
  let nextDelay = 250;
  try {
    const leaseId = crypto.randomUUID();
    const task = await store.claimNext({ workerId, leaseId, leaseDuration: LEASE_DURATION });
    if (currentRun !== runToken) return;

    if (!task) {
      return;
    }

    await runTask(task, leaseId);
    nextDelay = 0;
  } catch (error) {
    postMessage({ type: 'worker_error', workerId, error: String(error.stack || error) });
    nextDelay = 1000;
  } finally {
    if (currentRun === runToken) currentRun = null;
    schedulePoll(nextDelay);
  }
}

async function runTask(task, leaseId) {
  const skipHeartbeat = task.type === 'abandoned' || task.type === 'crashed';
  let leaseAlive = true;

  const heartbeat = skipHeartbeat
    ? null
    : setInterval(async () => {
        try {
          const renewed = await store.renewLease(task.id, leaseId, LEASE_DURATION);
          if (!renewed) leaseAlive = false;
        } catch (error) {
          leaseAlive = false;
          postMessage({ type: 'heartbeat_error', workerId, taskId: task.id, error: String(error) });
        }
      }, Math.floor(LEASE_DURATION / 3));

  if (task.type === 'crashed') {
    setTimeout(() => {
      throw new Error(`Simulated worker crash while executing ${task.id}`);
    }, Math.floor(LEASE_DURATION * 0.35));
  }

  postMessage({ type: 'task_started', workerId, task: serialize(task), at: Date.now() });

  try {
    const result = await executeTask(task);
    if (!leaseAlive) {
      postMessage({ type: 'task_result_ignored', workerId, taskId: task.id, at: Date.now() });
      return;
    }

    const finished = await store.finishTask(task.id, leaseId, { ok: true, result });
    postMessage({
      type: finished?.stale ? 'task_finish_stale' : 'task_finished',
      workerId,
      task: finished?.task ? serialize(finished.task) : null,
      at: Date.now()
    });
  } catch (error) {
    if (!leaseAlive) {
      postMessage({ type: 'task_failure_ignored', workerId, taskId: task.id, at: Date.now() });
      return;
    }

    const finished = await store.finishTask(task.id, leaseId, { ok: false, error });
    postMessage({
      type:
        finished?.task?.status === 'dead'
          ? 'task_dead_lettered'
          : finished?.stale
            ? 'task_finish_stale'
            : 'task_retry_scheduled',
      workerId,
      task: finished?.task ? serialize(finished.task) : null,
      reason: finished?.reason,
      at: Date.now()
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

function serialize(value) {
  return structuredClone(value);
}
