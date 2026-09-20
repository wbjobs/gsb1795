import {
  STATUSES,
  clamp,
  serializeError
} from './queue-policy.js';
import { runTask } from './task-handlers.js';
import {
  addTask,
  claimDueTask,
  clearTerminalTasks,
  completeTask,
  deleteTask,
  failTask,
  getAllTasks,
  openDatabase,
  recoverStaleLeases,
  renewLease,
  requeueAllDeadTasks,
  requeueTask
} from './idb.js';

const workerId = globalThis.crypto.randomUUID();
let database;
let concurrency = 3;
let paused = false;
let pumping = false;
let pumpTimer = null;
let snapshotTimer = null;

const activeExecutions = new Map();

function emit(type, payload = {}) {
  postMessage({
    type,
    at: Date.now(),
    workerId,
    ...payload
  });
}

function sendSnapshotNow() {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }

  return getAllTasks(database).then(tasks => {
    const now = Date.now();
    const counts = {
      queued: 0,
      running: 0,
      succeeded: 0,
      dead: 0
    };
    let nextWakeAt = null;

    for (const task of tasks) {
      counts[task.status] = (counts[task.status] || 0) + 1;
      if (task.status === STATUSES.QUEUED && task.runAfter > now) {
        nextWakeAt = nextWakeAt === null ? task.runAfter : Math.min(nextWakeAt, task.runAfter);
      } else if (task.status === STATUSES.QUEUED) {
        nextWakeAt = now;
      }
    }

    emit('snapshot', {
      snapshot: {
        workerId,
        concurrency,
        paused,
        activeCount: activeExecutions.size,
        nextWakeAt,
        now,
        counts,
        tasks,
        active: [...activeExecutions.values()].map(execution => ({
          id: execution.task.id,
          progress: execution.progress,
          message: execution.message,
          startedAt: execution.startedAt,
          attempts: execution.task.attempts
        }))
      }
    });
  }).catch(error => {
    emit('worker-error', { error: serializeError(error) });
  });
}

function scheduleSnapshot() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    sendSnapshotNow();
  }, 120);
}

function schedulePump(delay = 0) {
  clearTimeout(pumpTimer);
  pumpTimer = setTimeout(() => {
    pump();
  }, Math.max(0, delay));
}

async function recoverAndSnapshot(reason) {
  const recovered = await recoverStaleLeases(database);
  if (recovered.length > 0) {
    emit('leases-recovered', {
      reason,
      taskIds: recovered.map(task => task.id),
      count: recovered.length
    });
  }
  if (recovered.length > 0 && !paused) schedulePump(0);
  return recovered;
}

async function pump() {
  if (pumping || paused) return;
  pumping = true;

  try {
    await recoverAndSnapshot('scheduler-tick');

    while (activeExecutions.size < concurrency) {
      const claimed = await claimDueTask(database, {
        owner: workerId,
        excludeIds: new Set(activeExecutions.keys())
      });
      if (!claimed) break;

      emit('task-claimed', { taskId: claimed.id, attempts: claimed.attempts });
      executeTask(claimed);
    }

    const tasks = await getAllTasks(database);
    const now = Date.now();
    const waiting = tasks
      .filter(task => task.status === STATUSES.QUEUED && task.runAfter > now)
      .sort((left, right) => left.runAfter - right.runAfter);

    if (waiting.length > 0 && activeExecutions.size < concurrency) {
      schedulePump(Math.min(5000, Math.max(25, waiting[0].runAfter - now)));
    }

    await sendSnapshotNow();
  } catch (error) {
    emit('scheduler-error', { error: serializeError(error) });
  } finally {
    pumping = false;
  }
}

function executeTask(task) {
  const startedAt = Date.now();
  const execution = {
    task,
    startedAt,
    progress: 0,
    message: '任务已领取'
  };
  activeExecutions.set(task.id, execution);

  execution.heartbeat = setInterval(() => {
    renewLease(database, task.id, workerId)
      .then(renewed => {
        if (!renewed) clearInterval(execution.heartbeat);
      })
      .catch(error => emit('heartbeat-error', {
        taskId: task.id,
        error: serializeError(error)
      }));
  }, 1000);

  const emitProgress = (taskId, progress, message) => {
    const current = activeExecutions.get(taskId);
    if (!current) return;
    current.progress = clamp(progress, 0, 99);
    current.message = message;
    emit('task-progress', {
      taskId,
      progress: current.progress,
      message: current.message
    });
    scheduleSnapshot();
  };

  runTask(task, { emitProgress })
    .then(result => completeTask(database, task, result, { owner: workerId }))
    .then(completed => {
      if (!completed) {
        emit('task-result-ignored', {
          taskId: task.id,
          reason: 'lease-owner-changed'
        });
        return;
      }
      emit('task-succeeded', {
        taskId: task.id,
        result: completed.result,
        attempts: completed.attempts,
        duration: Date.now() - startedAt
      });
    })
    .catch(error => failTask(database, task, error, { owner: workerId })
      .then(transition => {
        if (!transition) return;
        emit(transition.retryable ? 'task-retrying' : 'task-dead-lettered', {
          taskId: task.id,
          attempts: transition.task.attempts,
          maxAttempts: transition.task.maxAttempts,
          delayMs: transition.delayMs,
          deadReason: transition.deadReason,
          message: transition.task.lastError
        });
      }))
    .catch(error => emit('execution-error', {
      taskId: task.id,
      error: serializeError(error)
    }))
    .finally(() => {
      clearInterval(execution.heartbeat);
      activeExecutions.delete(task.id);
      schedulePump(0);
      scheduleSnapshot();
    });
}

async function seedDemoTasks() {
  const specs = [
    { type: 'fatal', priority: 0, payload: { field: 'customerId' } },
    { type: 'flaky', priority: 0, payload: { failBefore: 3 }, maxAttempts: 4 },
    { type: 'dependency', priority: 1, maxAttempts: 2 },
    { type: 'slow', priority: 1, payload: { duration: 2800 } },
    { type: 'demo', priority: 2, payload: { value: 'A' } },
    { type: 'flaky', priority: 2, payload: { failBefore: 1 }, maxAttempts: 2 },
    { type: 'demo', priority: 0, payload: { value: 'P0' } },
    { type: 'flaky', priority: 1, payload: { failBefore: 5 }, maxAttempts: 3 },
    { type: 'slow', priority: 2, payload: { duration: 1800 } },
    { type: 'demo', priority: 1, payload: { value: 'batch' } }
  ];
  return Promise.all(specs.map(spec => addTask(database, spec)));
}

const commands = {
  ENQUEUE: async ({ task }) => addTask(database, task),
  ENQUEUE_BATCH: async ({ tasks = [] }) => Promise.all(tasks.map(task => addTask(database, task))),
  REQUEUE_ONE: async ({ id }) => requeueTask(database, id),
  REQUEUE_ALL: async () => requeueAllDeadTasks(database),
  DELETE_TASK: async ({ id }) => deleteTask(database, id),
  CLEAR_TERMINAL: async () => clearTerminalTasks(database),
  DEMO_SEED: async () => seedDemoTasks(),
  SNAPSHOT: async () => null,
  PAUSE: async () => {
    paused = true;
  },
  RESUME: async () => {
    paused = false;
  },
  SET_CONCURRENCY: async ({ value }) => {
    concurrency = clamp(Number.parseInt(value, 10) || 1, 1, 8);
  }
};

self.addEventListener('message', event => {
  const message = event.data || {};
  const command = commands[message.type];

  if (!command) {
    emit('unknown-command', { command: message.type });
    return;
  }

  command(message)
    .then(result => {
      if (message.type !== 'SNAPSHOT') {
        emit('command-complete', { command: message.type, result });
      }
    })
    .catch(error => emit('command-error', {
      command: message.type,
      error: serializeError(error)
    }))
    .finally(() => {
      if (!paused && message.type !== 'PAUSE') schedulePump(0);
      scheduleSnapshot();
    });
});

self.addEventListener('error', event => {
  emit('worker-error', { error: serializeError(event.error || event.message) });
});

openDatabase(self.indexedDB)
  .then(opened => {
    database = opened;
    return paused ? null : recoverAndSnapshot('worker-startup');
  })
  .then(() => sendSnapshotNow())
  .then(() => {
    setInterval(() => recoverAndSnapshot('lease-timeout').then(scheduleSnapshot), 5000);
    if (!paused) schedulePump(0);
    emit('worker-ready', { concurrency });
  })
  .catch(error => emit('worker-init-error', { error: serializeError(error) }));
