import { createTask, STATUSES } from './lib/task.js';
import { TaskStore } from './lib/storage.js';
import { errorCauseChain } from './lib/errors.js';
import { MonitorChart } from './ui/chart.js';

const WORKER_COUNT = 4;

const elements = {
  form: document.querySelector('#enqueue-form'),
  type: document.querySelector('#task-type'),
  priority: document.querySelector('#priority'),
  maxAttempts: document.querySelector('#max-attempts'),
  count: document.querySelector('#count'),
  demo: document.querySelector('#load-demo'),
  reset: document.querySelector('#reset-store'),
  requeueAll: document.querySelector('#requeue-all-dead'),
  counts: document.querySelectorAll('[data-count]'),
  workerState: document.querySelector('#worker-state'),
  canvas: document.querySelector('#monitor-canvas'),
  taskTable: document.querySelector('#task-table tbody'),
  eventList: document.querySelector('#event-list')
};

const store = new TaskStore();
const chart = new MonitorChart(elements.canvas);
const workers = new Map();

await bootstrap();

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const amount = clampInt(elements.count.value, 1, 20);
  const priority = Number(elements.priority.value);
  const maxAttempts = clampInt(elements.maxAttempts.value, 1, 20);
  const tasks = Array.from({ length: amount }, (_, index) =>
    createTask({
      type: elements.type.value,
      name: `${elements.type.selectedOptions[0].textContent} ${Date.now().toString(36)}-${index + 1}`,
      priority,
      maxAttempts,
      payload: payloadFor(elements.type.value, { priority, maxAttempts })
    })
  );
  await store.addTasks(tasks);
  await refresh();
});

elements.demo.addEventListener('click', async () => {
  const specs = [
    { type: 'success', priority: 1, maxAttempts: 3 },
    { type: 'flaky', priority: 8, maxAttempts: 4 },
    { type: 'flaky', priority: 3, maxAttempts: 2, payload: { failUntil: 99, duration: 300 } },
    { type: 'terminal', priority: 5, maxAttempts: 5 },
    { type: 'chained', priority: 7, maxAttempts: 2 },
    { type: 'slow', priority: 6, maxAttempts: 3 },
    { type: 'crashed', priority: 9, maxAttempts: 3 }
  ];
  await store.addTasks(specs.map((spec, index) => createTask({
    ...spec,
    name: `演示 ${spec.type} #${index + 1}`,
    payload: payloadFor(spec.type, spec)
  })));
  await refresh();
});

elements.reset.addEventListener('click', async () => {
  stopWorkers();
  await store.clearAll();
  chart.history.length = 0;
  startWorkers();
  await refresh();
});

elements.requeueAll.addEventListener('click', async () => {
  const tasks = await store.getAllTasks();
  for (const task of tasks.filter((item) => item.status === STATUSES.DEAD)) {
    await store.requeueDeadTask(task.id);
  }
  await refresh();
});

elements.taskTable.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-requeue]');
  if (!button) return;
  await store.requeueDeadTask(button.dataset.requeue);
  await refresh();
});

async function bootstrap() {
  await store.open();
  startWorkers();
  await refresh();
  setInterval(refresh, 500);
}

function startWorkers() {
  for (let index = 0; index < WORKER_COUNT; index += 1) {
    spawnWorker(index);
  }
  renderWorkers();
}

function spawnWorker(index) {
  const worker = new Worker('./src/workers/consumer-worker.js', { type: 'module' });
  const generation = (workers.get(index)?.generation || 0) + 1;
  const state = { worker, ready: false, currentTask: null, errors: workers.get(index)?.errors || 0, generation };
  worker.onmessage = (event) => handleWorkerMessage(index, state, event.data);
  worker.onerror = () => {
    if (workers.get(index)?.generation !== generation) return;
    state.errors += 1;
    state.ready = false;
    state.currentTask = null;
    worker.terminate();
    renderWorkers();
    setTimeout(() => spawnWorker(index), 1000);
  };
  workers.set(index, state);
}

function stopWorkers() {
  for (const state of workers.values()) state.worker.terminate();
  workers.clear();
}

function handleWorkerMessage(index, state, message) {
  if (message.type === 'worker_ready' || message.type === 'worker_started') {
    state.ready = true;
    state.currentTask = null;
  }
  if (message.type === 'task_started') {
    state.currentTask = message.task;
  }
  if (
    message.type === 'task_finished' ||
    message.type === 'task_retry_scheduled' ||
    message.type === 'task_dead_lettered' ||
    message.type === 'task_finish_stale' ||
    message.type === 'task_result_ignored' ||
    message.type === 'task_failure_ignored'
  ) {
    state.currentTask = null;
    queueMicrotask(refresh);
  }
  if (message.type === 'worker_error' || message.type === 'heartbeat_error') {
    state.errors += 1;
  }
  renderWorkers();
}

async function refresh() {
  const [counts, tasks, events] = await Promise.all([
    store.countByStatus(),
    store.getAllTasks(),
    store.listEvents(12)
  ]);

  for (const element of elements.counts) {
    element.textContent = counts[element.dataset.count] ?? 0;
  }
  renderTasks(tasks);
  renderEvents(events);
  chart.push({
    counts,
    runningWorkers: [...workers.values()].filter((state) => state.ready).length,
    at: Date.now()
  });
}

function renderWorkers() {
  elements.workerState.innerHTML = '';
  for (const [index, state] of workers) {
    const chip = document.createElement('span');
    chip.className = `worker-chip ${state.currentTask ? 'busy' : 'idle'}`;
    const taskName = state.currentTask?.name || '空闲';
    chip.textContent = `W${index + 1} ${taskName}`;
    if (state.errors > 0) chip.dataset.errors = state.errors;
    elements.workerState.append(chip);
  }
}

function renderTasks(tasks) {
  elements.taskTable.innerHTML = '';
  const fragment = document.createDocumentFragment();

  for (const task of tasks.slice(0, 30)) {
    const row = document.createElement('tr');
    row.className = `status-${task.status}`;
    const nextRun = task.availableAt ? formatRelative(task.availableAt) : '—';
    const chain = task.errorChain.length
      ? task.errorChain.map((entry) => {
          const chainText = errorCauseChain(entry.error).join(' ← ');
          return `<li>#${entry.attempt} ${escapeHtml(chainText)}</li>`;
        }).join('')
      : '<li class="muted">无</li>';

    row.innerHTML = `
      <td><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.id)}</small></td>
      <td><span class="badge">${escapeHtml(task.type)}</span></td>
      <td>P${task.priority}</td>
      <td>${task.attempts}/${task.maxAttempts}</td>
      <td><span class="status">${statusLabel(task.status)}</span></td>
      <td>${nextRun}</td>
      <td>${task.leaseOwner ? escapeHtml(task.leaseOwner) : '—'}</td>
      <td><ol class="error-chain">${chain}</ol></td>
      <td>${task.status === STATUSES.DEAD ? `<button class="small" data-requeue="${escapeHtml(task.id, true)}">重入</button>` : ''}</td>
    `;
    fragment.append(row);
  }

  elements.taskTable.append(fragment);
}

function renderEvents(events) {
  elements.eventList.innerHTML = events
    .map((event) => {
      const detail = event.detail?.retryAt
        ? ` → ${formatRelative(event.detail.retryAt)}`
        : event.detail?.reason ? ` (${event.detail.reason})` : '';
      return `<li><time>${new Date(event.createdAt).toLocaleTimeString()}</time><span>${escapeHtml(eventLabel(event.type))} · ${escapeHtml(event.taskName)}${escapeHtml(detail)}</span></li>`;
    })
    .join('');
}

function payloadFor(type, spec = {}) {
  if (spec.payload) return spec.payload;
  if (type === 'flaky') return { failUntil: Math.min(2, Number(spec.maxAttempts ?? 4) - 1), duration: 500 };
  if (type === 'terminal') return { field: 'email', duration: 200 };
  if (type === 'chained') return { duration: 200 };
  if (type === 'slow') return { duration: 4200 };
  if (type === 'crashed') return { duration: 60000 };
  return { value: 'done', duration: 400 };
}

function statusLabel(status) {
  return { queued: '等待中', retrying: '退避重试', running: '执行中', succeeded: '已成功', dead: '死信' }[status];
}

function eventLabel(type) {
  return {
    task_enqueued: '入队',
    task_claimed: '领取',
    task_succeeded: '成功',
    task_retry_scheduled: '安排重试',
    task_dead_lettered: '进入死信',
    lease_expired: '租约过期',
    dead_letter_requeued: '死信重入'
  }[type] || type;
}

function formatRelative(timestamp) {
  const diff = Math.max(0, timestamp - Date.now());
  return `${new Date(timestamp).toLocaleTimeString()} (${Math.ceil(diff / 1000)}s)`;
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.trunc(Number(value) || min)));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}
