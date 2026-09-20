import {
  STATUSES,
  claimTask,
  compareTaskPriority,
  completeTask,
  recoverExpiredLease,
  renewLease,
  requeueDeadTask
} from './task.js';

const DB_VERSION = 1;
const TASKS_STORE = 'tasks';
const EVENTS_STORE = 'events';

export class TaskStore {
  constructor(dbName = 'resilient-task-queue') {
    this.dbName = dbName;
    this.db = null;
  }

  open() {
    if (this.db) return Promise.resolve(this.db);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(TASKS_STORE)) {
          const tasks = db.createObjectStore(TASKS_STORE, { keyPath: 'id' });
          tasks.createIndex('status', 'status');
          tasks.createIndex('priority', 'priority');
          tasks.createIndex('availableAt', 'availableAt');
          tasks.createIndex('updatedAt', 'updatedAt');
          tasks.createIndex('deadAt', 'deadAt');
        }
        if (!db.objectStoreNames.contains(EVENTS_STORE)) {
          const events = db.createObjectStore(EVENTS_STORE, { keyPath: 'id' });
          events.createIndex('taskId', 'taskId');
          events.createIndex('createdAt', 'createdAt');
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another tab'));
    });
  }

  async close() {
    this.db?.close();
    this.db = null;
  }

  async addTasks(tasks) {
    await this.open();
    return this.#withTransaction([TASKS_STORE, EVENTS_STORE], 'readwrite', ([taskStore, eventStore]) => {
      for (const task of tasks) {
        taskStore.add(task);
        eventStore.add(createEvent('task_enqueued', task, { priority: task.priority }));
      }
    });
  }

  async getTask(id) {
    await this.open();
    return this.#request(this.db.transaction(TASKS_STORE).objectStore(TASKS_STORE).get(id));
  }

  async getAllTasks() {
    await this.open();
    const tasks = await this.#request(
      this.db.transaction(TASKS_STORE).objectStore(TASKS_STORE).getAll()
    );
    return tasks.sort(
      (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)
    );
  }

  async claimNext(options) {
    await this.open();
    return this.#withTransaction(
      [TASKS_STORE, EVENTS_STORE],
      'readwrite',
      ([taskStore, eventStore], resolve, reject, now) => {
        const allRequest = taskStore.getAll();
        allRequest.onsuccess = () => {
          try {
            const tasks = allRequest.result;
            for (const task of tasks) {
              if (task.status !== STATUSES.RUNNING || task.leaseExpiresAt > now) continue;
              const recovered = recoverExpiredLease(task, { now });
              if (!recovered) continue;
              Object.assign(task, recovered.task);
              taskStore.put(recovered.task);
              eventStore.put(createEvent('lease_expired', recovered.task, { reason: recovered.reason }));
            }

            const candidate = tasks
              .filter((task) => task.status === STATUSES.QUEUED || task.status === STATUSES.RETRYING)
              .filter((task) => task.availableAt <= now)
              .sort(compareTaskPriority)[0];

            if (!candidate) {
              resolve(null);
              return;
            }

            const claimed = claimTask(candidate, {
              now,
              leaseId: options.leaseId,
              workerId: options.workerId,
              leaseDuration: options.leaseDuration
            });
            if (!claimed) {
              resolve(null);
              return;
            }
            taskStore.put(claimed);
            eventStore.put(createEvent('task_claimed', claimed, { workerId: options.workerId }));
            resolve(claimed);
          } catch (error) {
            reject(error);
          }
        };
        allRequest.onerror = () => reject(allRequest.error);
      },
      null,
      options.now ?? Date.now()
    );
  }

  async finishTask(taskId, leaseId, outcome, now = Date.now()) {
    await this.open();
    return this.#withTransaction(
      [TASKS_STORE, EVENTS_STORE],
      'readwrite',
      ([taskStore, eventStore], resolve, reject) => {
        const getRequest = taskStore.get(taskId);
        getRequest.onsuccess = () => {
          const current = getRequest.result;
          if (!current) {
            resolve(null);
            return;
          }

          const completion = completeTask(current, {
            now,
            leaseId,
            result: outcome.ok ? outcome.result : null,
            error: outcome.ok ? null : outcome.error
          });

          if (completion.stale) {
            resolve({ stale: true, task: current });
            return;
          }

          taskStore.put(completion.task);
          const eventType =
            completion.task.status === STATUSES.SUCCEEDED
              ? 'task_succeeded'
              : completion.task.status === STATUSES.DEAD
                ? 'task_dead_lettered'
                : 'task_retry_scheduled';
          eventStore.put(
            createEvent(eventType, completion.task, {
              reason: completion.reason,
              retryAt: completion.task.availableAt
            })
          );
          resolve({ stale: false, task: completion.task, reason: completion.reason });
        };
        getRequest.onerror = () => reject(getRequest.error);
      }
    );
  }

  async renewLease(taskId, leaseId, leaseDuration, now = Date.now()) {
    await this.open();
    return this.#withTransaction([TASKS_STORE], 'readwrite', ([taskStore], resolve, reject) => {
      const request = taskStore.get(taskId);
      request.onsuccess = () => {
        const renewed = renewLease(request.result, { leaseId, leaseDuration, now });
        if (!renewed) {
          resolve(null);
          return;
        }
        taskStore.put(renewed);
        resolve(renewed);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async requeueDeadTask(id, options = {}) {
    await this.open();
    const now = options.now ?? Date.now();
    return this.#withTransaction(
      [TASKS_STORE, EVENTS_STORE],
      'readwrite',
      ([taskStore, eventStore], resolve, reject) => {
        const request = taskStore.get(id);
        request.onsuccess = () => {
          const deadTask = request.result;
          if (!deadTask) {
            reject(new Error(`Task ${id} does not exist`));
            return;
          }
          const requeued = requeueDeadTask(deadTask, {
            now,
            delay: options.delay ?? 0,
            backoff: options.backoff
          });
          taskStore.put(requeued);
          eventStore.put(
            createEvent('dead_letter_requeued', requeued, {
              requeueCount: requeued.requeueCount
            })
          );
          resolve(requeued);
        };
        request.onerror = () => reject(request.error);
      }
    );
  }

  async countByStatus() {
    await this.open();
    const counts = { queued: 0, retrying: 0, running: 0, succeeded: 0, dead: 0 };
    await Promise.all(
      Object.values(STATUSES).map(
        async (status) =>
          (counts[status] = await this.#request(
            this.db
              .transaction(TASKS_STORE)
              .objectStore(TASKS_STORE)
              .index('status')
              .count(IDBKeyRange.only(status))
          ))
      )
    );
    return counts;
  }

  async listEvents(limit = 100) {
    await this.open();
    const events = await this.#request(
      this.db.transaction(EVENTS_STORE).objectStore(EVENTS_STORE).getAll()
    );
    return events
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  async clearAll() {
    await this.open();
    await this.#withTransaction([TASKS_STORE, EVENTS_STORE], 'readwrite', ([tasks, events]) => {
      tasks.clear();
      events.clear();
    });
  }

  #withTransaction(storeNames, mode, operation, result = null, now = Date.now()) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeNames, mode);
      const stores = storeNames.map((name) => transaction.objectStore(name));
      let operationResult = result;
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          operationResult = value;
        }
      };
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      try {
        operation(stores, finish, fail, now, transaction);
      } catch (error) {
        fail(error);
      }
      transaction.oncomplete = () => resolve(operationResult);
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error || new Error('IndexedDB transaction aborted'));
    });
  }

  #request(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

function createEvent(type, task, detail = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    taskId: task.id,
    taskName: task.name,
    status: task.status,
    attempts: task.attempts,
    workerId: task.leaseOwner,
    detail,
    createdAt: Date.now()
  };
}
