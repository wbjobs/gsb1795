import { PRIORITIES, STATUSES } from './queue-policy.js';
import { TASK_TYPES } from './task-handlers.js';
import { TaskDashboard } from './dashboard.js';

const $ = selector => document.querySelector(selector);

const elements = {
  canvas: $('#board'),
  form: $('#add-task-form'),
  type: $('#task-type'),
  priority: $('#task-priority'),
  maxAttempts: $('#max-attempts'),
  payload: $('#task-payload'),
  seed: $('#seed-demo'),
  pause: $('#pause-queue'),
  resume: $('#resume-queue'),
  requeueAll: $('#requeue-all'),
  clearTerminal: $('#clear-terminal'),
  detail: $('#task-detail'),
  eventLog: $('#event-log')
};

const payloadExamples = {
  demo: { value: 'hello' },
  flaky: { failBefore: 3 },
  slow: { duration: 2400 },
  fatal: { field: 'customerId' },
  dependency: {}
};

const priorityLabels = {
  [PRIORITIES.HIGH]: '高',
  [PRIORITIES.NORMAL]: '普通',
  [PRIORITIES.LOW]: '低'
};

for (const type of TASK_TYPES) {
  const option = document.createElement('option');
  option.value = type.value;
  option.textContent = type.label;
  elements.type.appendChild(option);
}

elements.type.value = 'flaky';
elements.payload.value = JSON.stringify(payloadExamples.flaky, null, 2);
elements.type.addEventListener('change', () => {
  elements.payload.value = JSON.stringify(payloadExamples[elements.type.value] || {}, null, 2);
});

const dashboard = new TaskDashboard(elements.canvas, {
  onSelectTask: id => {
    dashboard.setSelected(id);
    renderSelectedTask(id);
  }
});

let latestSnapshot = {
  tasks: [],
  active: [],
  counts: {},
  concurrency: 3,
  activeCount: 0,
  paused: false
};
let selectedTaskId = null;

const worker = new Worker('./js/worker.js', { type: 'module' });
const pausedOnLoad = localStorage.getItem('task-queue.paused') === 'true';
elements.pause.disabled = pausedOnLoad;
elements.resume.disabled = !pausedOnLoad;

function post(type, payload = {}) {
  worker.postMessage({ type, ...payload });
}

function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function addEventLog(type, payload) {
  const item = document.createElement('div');
  item.className = `event event-${type}`;
  const label = {
    'worker-ready': 'Worker 就绪',
    'task-claimed': '领取任务',
    'task-progress': '执行进度',
    'task-retrying': '退避重试',
    'task-dead-lettered': '进入死信',
    'task-succeeded': '执行成功',
    'leases-recovered': '租约恢复',
    'command-error': '命令失败',
    'scheduler-error': '调度失败',
    'worker-error': 'Worker 异常',
    'worker-init-error': '初始化失败'
  }[type] || type;

  const detail = payload.taskId
    ? `${payload.taskId.slice(0, 8)}${payload.delayMs ? ` · ${payload.delayMs}ms` : ''}`
    : payload.message || payload.reason || '';
  item.textContent = `${formatTime(payload.at || Date.now())} ${label} ${detail}`;
  elements.eventLog.prepend(item);
  while (elements.eventLog.children.length > 60) {
    elements.eventLog.lastElementChild.remove();
  }
}

worker.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'snapshot') {
    latestSnapshot = message.snapshot;
    dashboard.setState(latestSnapshot);
    renderSelectedTask(selectedTaskId);
    elements.pause.disabled = latestSnapshot.paused;
    elements.resume.disabled = !latestSnapshot.paused;
    return;
  }

  addEventLog(message.type, message);
  if (message.type === 'worker-ready') {
    if (pausedOnLoad) post('PAUSE');
    post('SNAPSHOT');
  }
});

worker.addEventListener('error', event => {
  addEventLog('worker-error', { message: event.message, at: Date.now() });
});

elements.form.addEventListener('submit', event => {
  event.preventDefault();
  let payload;
  try {
    payload = JSON.parse(elements.payload.value || '{}');
  } catch (error) {
    alert(`Payload 不是合法 JSON：${error.message}`);
    return;
  }

  post('ENQUEUE', {
    task: {
      type: elements.type.value,
      priority: Number(elements.priority.value),
      maxAttempts: Number(elements.maxAttempts.value),
      payload
    }
  });
});

elements.seed.addEventListener('click', () => post('DEMO_SEED'));
elements.pause.addEventListener('click', () => {
  localStorage.setItem('task-queue.paused', 'true');
  post('PAUSE');
});
elements.resume.addEventListener('click', () => {
  localStorage.removeItem('task-queue.paused');
  post('RESUME');
});
elements.requeueAll.addEventListener('click', () => post('REQUEUE_ALL'));
elements.clearTerminal.addEventListener('click', () => {
  if (confirm('清空所有成功和死信任务？')) post('CLEAR_TERMINAL');
});

$('#concurrency').addEventListener('change', event => {
  post('SET_CONCURRENCY', { value: Number(event.target.value) });
});

function renderErrorChain(chain) {
  if (!chain?.length) return '<p class="muted">暂无异常记录</p>';
  return chain.map(failure => `
    <details class="failure" ${failure.deadReason ? 'open' : ''}>
      <summary>
        <span>${formatTime(failure.at)} · 第 ${failure.attempt} 次</span>
        <strong>${failure.deadReason ? '死信' : '可重试'}</strong>
      </summary>
      ${renderErrorNode(failure.error)}
    </details>
  `).join('');
}

function renderErrorNode(node, depth = 0) {
  if (!node) return '';
  const stack = Array.isArray(node.stack)
    ? `<pre>${node.stack.map(line => escapeHtml(line)).join('\n')}</pre>`
    : '';
  return `
    <div class="error-node" style="margin-left:${depth * 12}px">
      <code>${escapeHtml(node.name || 'Error')}</code>
      <p>${escapeHtml(node.message || '')}</p>
      ${node.code ? `<span class="badge">${escapeHtml(node.code)}</span>` : ''}
      ${stack}
      ${node.cause ? renderErrorNode(node.cause, depth + 1) : ''}
    </div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderSelectedTask(id) {
  if (!id) {
    elements.detail.innerHTML = '<p class="muted">点击 Canvas 任务卡片查看租约、退避、结果和异常链路。</p>';
    return;
  }

  const task = latestSnapshot.tasks.find(item => item.id === id);
  if (!task) {
    selectedTaskId = null;
    elements.detail.innerHTML = '<p class="muted">任务不存在或已被清理。</p>';
    return;
  }

  selectedTaskId = id;
  const isDead = task.status === STATUSES.DEAD;
  elements.detail.innerHTML = `
    <div class="detail-head">
      <h2>${escapeHtml(task.type)}</h2>
      <span class="status status-${task.status}">${task.status}</span>
    </div>
    <dl class="task-meta">
      <dt>ID</dt><dd><code>${escapeHtml(task.id)}</code></dd>
      <dt>优先级</dt><dd>${priorityLabels[task.priority]}</dd>
      <dt>尝试</dt><dd>${task.attempts}/${task.maxAttempts}</dd>
      <dt>重入次数</dt><dd>${task.reentryCount}</dd>
      <dt>租约</dt><dd>${escapeHtml(task.leaseOwner ? task.leaseOwner.slice(0, 8) : '—')}</dd>
      <dt>上次退避</dt><dd>${task.lastBackoffMs === null ? '—' : `${task.lastBackoffMs}ms`}</dd>
      <dt>创建</dt><dd>${formatTime(task.createdAt)}</dd>
      <dt>完成</dt><dd>${formatTime(task.completedAt)}</dd>
    </dl>
    <h3>Payload</h3>
    <pre>${escapeHtml(JSON.stringify(task.payload, null, 2))}</pre>
    <h3>结果</h3>
    <pre>${escapeHtml(JSON.stringify(task.result, null, 2))}</pre>
    <h3>异常链路</h3>
    ${renderErrorChain(task.errorChain)}
    <div class="detail-actions">
      <button id="requeue-one" ${isDead ? '' : 'disabled'}>死信重入</button>
      <button id="delete-one" class="danger">删除</button>
    </div>
  `;

  $('#requeue-one')?.addEventListener('click', () => post('REQUEUE_ONE', { id }));
  $('#delete-one')?.addEventListener('click', () => {
    post('DELETE_TASK', { id });
    selectedTaskId = null;
    dashboard.setSelected(null);
  });
}

function animationTick() {
  dashboard.render();
  requestAnimationFrame(animationTick);
}

requestAnimationFrame(animationTick);

post('SNAPSHOT');
