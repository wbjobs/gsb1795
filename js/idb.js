import {
  DEFAULT_BACKOFF,
  STATUSES,
  claimTask,
  createTask,
  failureTransition,
  recoverLease,
  requeueDeadTask,
  selectDueTasks,
  successTransition
} from './queue-policy.js';

export const DB_NAME = 'task-queue-canvas-db';
export const DB_VERSION = 1;
export const TASK_STORE = 'tasks';

function openDatabase(indexedDB = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TASK_STORE)) {
        const store = database.createObjectStore(TASK_STORE, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('status_runAfter', [
          'status',
          'runAfter'
        ], { unique: false });
        store.createIndex('status_priority_runAfter_created', [
          'status',
          'priority',
          'runAfter',
          'createdAt'
        ], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function withTransaction(database, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(TASK_STORE, mode);
    const store = transaction.objectStore(TASK_STORE);
    let result;

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));

    Promise.resolve(operation(store))
      .then(value => { result = value; })
      .catch(error => {
        try { transaction.abort(); } catch { /* already finished */ }
        reject(error);
      });
  });
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function getAllTasks(database) {
  return withTransaction(database, 'readonly', async store => requestPromise(store.getAll()));
}

function putTask(store, task) {
  return requestPromise(store.put(task));
}

export function addTask(database, input = {}) {
  const task = createTask(input);
  return withTransaction(database, 'readwrite', async store => {
    await putTask(store, task);
    return task;
  });
}

export function persistPatch(database, task) {
  return withTransaction(database, 'readwrite', store => putTask(store, task));
}

export function getTask(database, id) {
  return withTransaction(database, 'readonly', store => requestPromise(store.get(id)));
}

export async function claimDueTask(database, {
  now = Date.now(),
  owner,
  leaseDuration = DEFAULT_BACKOFF.leaseDuration,
  excludeIds = new Set()
}) {
  return withTransaction(database, 'readwrite', async store => {
    return new Promise((resolve, reject) => {
      const getAllRequest = store.getAll();
      getAllRequest.onerror = () => reject(getAllRequest.error);
      getAllRequest.onsuccess = () => {
        try {
          const [selected] = selectDueTasks(getAllRequest.result, { now, excludeIds });
          if (!selected) {
            resolve(null);
            return;
          }

          const claimed = claimTask(selected, { now, owner, leaseDuration });
          const putRequest = store.put(claimed);
          putRequest.onerror = () => reject(putRequest.error);
          putRequest.onsuccess = () => resolve(claimed);
        } catch (error) {
          reject(error);
        }
      };
    });
  });
}

export async function completeTask(database, task, result, { now = Date.now(), owner } = {}) {
  return withTransaction(database, 'readwrite', store => new Promise((resolve, reject) => {
    const getRequest = store.get(task.id);
    getRequest.onerror = () => reject(getRequest.error);
    getRequest.onsuccess = () => {
      const current = getRequest.result;
      if (!current
        || current.status !== STATUSES.RUNNING
        || (owner !== undefined && current.leaseOwner !== owner)) {
        resolve(null);
        return;
      }

      const completed = successTransition(current, result, { now });
      const putRequest = store.put(completed);
      putRequest.onerror = () => reject(putRequest.error);
      putRequest.onsuccess = () => resolve(completed);
    };
  }));
}

export async function failTask(database, task, error, options = {}) {
  const { owner } = options;
  return withTransaction(database, 'readwrite', store => new Promise((resolve, reject) => {
    const getRequest = store.get(task.id);
    getRequest.onerror = () => reject(getRequest.error);
    getRequest.onsuccess = () => {
      const current = getRequest.result;
      if (!current
        || current.status !== STATUSES.RUNNING
        || (owner !== undefined && current.leaseOwner !== owner)) {
        resolve(null);
        return;
      }

      const transition = failureTransition(current, error, options);
      const putRequest = store.put(transition.task);
      putRequest.onerror = () => reject(putRequest.error);
      putRequest.onsuccess = () => resolve(transition);
    };
  }));
}

export async function requeueTask(database, id, { now = Date.now() } = {}) {
  return withTransaction(database, 'readwrite', store => new Promise((resolve, reject) => {
    const getRequest = store.get(id);
    getRequest.onerror = () => reject(getRequest.error);
    getRequest.onsuccess = () => {
      const current = getRequest.result;
      if (!current || current.status !== STATUSES.DEAD) {
        resolve(null);
        return;
      }

      const requeued = requeueDeadTask(current, { now });
      const putRequest = store.put(requeued);
      putRequest.onerror = () => reject(putRequest.error);
      putRequest.onsuccess = () => resolve(requeued);
    };
  }));
}

export async function requeueAllDeadTasks(database, { now = Date.now() } = {}) {
  return withTransaction(database, 'readwrite', store => new Promise((resolve, reject) => {
    const getAllRequest = store.getAll();
    getAllRequest.onerror = () => reject(getAllRequest.error);
    getAllRequest.onsuccess = () => {
      const requeued = getAllRequest.result
      .filter(task => task.status === STATUSES.DEAD)
        .map(task => requeueDeadTask(task, { now }));
      requeued.forEach(task => store.put(task));
      resolve(requeued);
    };
  }));
}

export async function deleteTask(database, id) {
  return withTransaction(database, 'readwrite', async store => {
    await requestPromise(store.delete(id));
  });
}

export async function clearTerminalTasks(database) {
  return withTransaction(database, 'readwrite', store => new Promise((resolve, reject) => {
    const getAllRequest = store.getAll();
    getAllRequest.onerror = () => reject(getAllRequest.error);
    getAllRequest.onsuccess = () => {
      const terminalStatuses = new Set([STATUSES.SUCCEEDED, STATUSES.DEAD]);
      getAllRequest.result
      .filter(task => terminalStatuses.has(task.status))
        .forEach(task => store.delete(task.id));
      resolve();
    };
  }));
}

export async function recoverStaleLeases(database, { now = Date.now() } = {}) {
  return withTransaction(database, 'readwrite', store => new Promise((resolve, reject) => {
    const getAllRequest = store.getAll();
    getAllRequest.onerror = () => reject(getAllRequest.error);
    getAllRequest.onsuccess = () => {
      const all = getAllRequest.result;
      const recovered = all
      .map(task => recoverLease(task, { now }))
        .filter((task, index) => task !== all[index]);
      recovered.forEach(task => store.put(task));
      resolve(recovered);
    };
  }));
}

export async function renewLease(database, taskId, owner, {
  now = Date.now(),
  leaseDuration = DEFAULT_BACKOFF.leaseDuration
} = {}) {
  return withTransaction(database, 'readwrite', store => new Promise((resolve, reject) => {
    const getRequest = store.get(taskId);
    getRequest.onerror = () => reject(getRequest.error);
    getRequest.onsuccess = () => {
      const current = getRequest.result;
      if (!current || current.status !== STATUSES.RUNNING || current.leaseOwner !== owner) {
        resolve(false);
        return;
      }

      const putRequest = store.put({
      ...current,
      leaseUntil: now + leaseDuration,
      updatedAt: now
      });
      putRequest.onerror = () => reject(putRequest.error);
      putRequest.onsuccess = () => resolve(true);
    };
  }));
}

export { openDatabase };
