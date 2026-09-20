import { PRIORITIES, STATUSES } from './queue-policy.js';

const PRIORITY_LABELS = {
  [PRIORITIES.HIGH]: '高',
  [PRIORITIES.NORMAL]: '普通',
  [PRIORITIES.LOW]: '低'
};

const COLUMNS = [
  { status: STATUSES.QUEUED, title: '等待 / 退避', color: '#38bdf8' },
  { status: STATUSES.RUNNING, title: '并发消费', color: '#a78bfa' },
  { status: STATUSES.SUCCEEDED, title: '成功', color: '#34d399' },
  { status: STATUSES.DEAD, title: '死信', color: '#fb7185' }
];

const TYPE_LABELS = {
  demo: '演示',
  flaky: '间歇失败',
  slow: '慢速',
  fatal: '不可重试',
  dependency: '异常链路'
};

const DEAD_REASONS = {
  max_attempts: '超过重试上限',
  non_retryable: '不可重试异常'
};

export class TaskDashboard {
  constructor(canvas, { onSelectTask } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.state = {
      tasks: [],
      active: [],
      counts: {},
      concurrency: 0,
      activeCount: 0,
      paused: false,
      nextWakeAt: null,
      now: Date.now()
    };
    this.onSelectTask = onSelectTask;
    this.selectedId = null;
    this.cardHitAreas = [];
    this.scrollOffsets = new Map(COLUMNS.map(column => [column.status, 0]));
    this.resize();
    this.bindEvents();
  }

  bindEvents() {
    window.addEventListener('resize', () => {
      this.resize();
      this.render();
    });

    this.canvas.addEventListener('click', event => {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const hit = this.cardHitAreas.find(area => x >= area.x
        && x <= area.x + area.width
        && y >= area.y
        && y <= area.y + area.height);
      if (hit) this.onSelectTask?.(hit.id);
    });

    this.canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const padding = 20;
      const gap = 14;
      const columnWidth = (this.width - padding * 2 - gap * 3) / 4;
      const column = COLUMNS.find((_, index) => {
        const columnX = padding + index * (columnWidth + gap);
        return x >= columnX && x <= columnX + columnWidth;
      });
      if (!column) return;

      const current = this.scrollOffsets.get(column.status) || 0;
      this.scrollOffsets.set(column.status, Math.max(0, current + event.deltaY));
      this.render();
    }, { passive: false });
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
  }

  setState(snapshot) {
    this.state = {
      ...this.state,
      ...snapshot,
      now: Date.now()
    };
  }

  setSelected(id) {
    this.selectedId = id;
    this.render();
  }

  render() {
    const ctx = this.context;
    this.cardHitAreas = [];
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawBackground();
    this.drawHeader();
    this.drawColumns();
  }

  drawBackground() {
    const ctx = this.context;
    const gradient = ctx.createLinearGradient(0, 0, this.width, this.height);
    gradient.addColorStop(0, '#0f172a');
    gradient.addColorStop(1, '#111827');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  drawHeader() {
    const { counts, concurrency, activeCount, paused, nextWakeAt } = this.state;
    const now = Date.now();
    const metrics = [
      ['等待', counts.queued || 0, '#38bdf8'],
      ['执行', `${activeCount || 0}/${concurrency}`, '#a78bfa'],
      ['成功', counts.succeeded || 0, '#34d399'],
      ['死信', counts.dead || 0, '#fb7185']
    ];

    const ctx = this.context;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e5e7eb';
    ctx.font = '700 20px system-ui, sans-serif';
    ctx.fillText('IndexedDB + Worker 可靠任务队列', 24, 30);

    ctx.font = '500 13px system-ui, sans-serif';
    ctx.fillStyle = paused ? '#fbbf24' : '#94a3b8';
    const wakeText = paused
      ? '调度器已暂停'
      : nextWakeAt && nextWakeAt > now
        ? `下次唤醒 ${Math.ceil((nextWakeAt - now) / 1000)}s`
        : '调度器运行中';
    ctx.fillText(wakeText, 24, 58);

    let x = this.width - 24;
    for (let index = metrics.length - 1; index >= 0; index -= 1) {
      const [label, value, color] = metrics[index];
      const text = `${label} ${value}`;
      ctx.font = '700 14px system-ui, sans-serif';
      const width = ctx.measureText(text).width + 24;
      x -= width;
      this.roundRect(x, 22, width, 38, 12, color, 0.12);
      ctx.fillStyle = color;
      ctx.fillText(text, x + 12, 42);
      x -= 12;
    }
  }

  drawColumns() {
    const padding = 20;
    const gap = 14;
    const top = 82;
    const columnWidth = (this.width - padding * 2 - gap * 3) / 4;

    COLUMNS.forEach((column, index) => {
      const x = padding + index * (columnWidth + gap);
      this.drawColumn(column, x, top, columnWidth, this.height - top - padding);
    });
  }

  drawColumn(column, x, y, width, height) {
    const ctx = this.context;
    const tasks = this.state.tasks
      .filter(task => task.status === column.status)
      .sort(this.compareTasks.bind(this));

    this.roundRect(x, y, width, height, 18, '#1e293b', 0.72);
    ctx.fillStyle = column.color;
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${column.title} · ${tasks.length}`, x + 16, y + 24);

    if (column.status === STATUSES.RUNNING) {
      this.drawConcurrencySlots(x + 16, y + 42, width - 32);
    }

    const cardsTop = y + (column.status === STATUSES.RUNNING ? 78 : 52);
    const cardHeight = 82;
    const cardGap = 10;
    const scrollOffset = Math.min(
      this.scrollOffsets.get(column.status) || 0,
      Math.max(0, tasks.length * (cardHeight + cardGap) - (height - (cardsTop - y) - 12))
    );
    this.scrollOffsets.set(column.status, scrollOffset);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, cardsTop - 6, width - 2, height - (cardsTop - y) - 6);
    ctx.clip();
    tasks.forEach((task, index) => {
      const cardY = cardsTop + index * (cardHeight + cardGap) - scrollOffset;
      if (cardY < y + 40 || cardY + cardHeight > y + height) return;
      this.drawTaskCard(task, x + 12, cardY, width - 24, cardHeight, column.color);
    });
    ctx.restore();
  }

  drawConcurrencySlots(x, y, width) {
    const slotWidth = (width - 8 * (this.state.concurrency - 1)) / this.state.concurrency;
    for (let index = 0; index < this.state.concurrency; index += 1) {
      const active = index < this.state.activeCount;
      this.roundRect(x + index * (slotWidth + 8), y, slotWidth, 10, 5, active ? '#a78bfa' : '#334155', active ? 0.9 : 0.7);
    }
  }

  compareTasks(left, right) {
    if (left.status === STATUSES.QUEUED) {
      return left.priority - right.priority
        || (left.runAfter || 0) - (right.runAfter || 0)
        || left.createdAt - right.createdAt;
    }
    if (left.status === STATUSES.RUNNING) return left.startedAt - right.startedAt;
    return (right.completedAt || 0) - (left.completedAt || 0);
  }

  drawTaskCard(task, x, y, width, height, accent) {
    const ctx = this.context;
    const active = this.state.active.find(item => item.id === task.id);
    const selected = task.id === this.selectedId;
    this.roundRect(x, y, width, height, 14, selected ? '#334155' : '#0f172a', selected ? 0.98 : 0.72);
    ctx.strokeStyle = accent;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x + 1, y + 14);
    ctx.quadraticCurveTo(x + 1, y + 1, x + 14, y + 1);
    ctx.lineTo(x + width - 14, y + 1);
    ctx.quadraticCurveTo(x + width - 1, y + 1, x + width - 1, y + 14);
    ctx.lineTo(x + width - 1, y + height - 14);
    ctx.quadraticCurveTo(x + width - 1, y + height - 1, x + width - 14, y + height - 1);
    ctx.lineTo(x + 14, y + height - 1);
    ctx.quadraticCurveTo(x + 1, y + height - 1, x + 1, y + height - 14);
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.fillRect(x, y + 12, 4, height - 24);

    ctx.textBaseline = 'top';
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(`${TYPE_LABELS[task.type] || task.type} · ${PRIORITY_LABELS[task.priority]}`, x + 14, y + 11, width - 28);

    ctx.font = '500 11px system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    const meta = task.status === STATUSES.QUEUED
      ? this.queuedMeta(task)
      : task.status === STATUSES.DEAD
        ? DEAD_REASONS[task.deadReason] || task.deadReason
        : `尝试 ${task.attempts}/${task.maxAttempts}`;
    ctx.fillText(meta, x + 14, y + 32, width - 28);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 10px ui-monospace, monospace';
    ctx.fillText(task.id.slice(0, 8), x + 14, y + 51, width - 28);

    if (task.status === STATUSES.RUNNING) {
      this.drawProgressBar(x + 14, y + height - 15, width - 28, 5, active?.progress || 0, accent);
    } else {
      ctx.fillStyle = '#64748b';
      ctx.fillText(task.lastError ? '查看异常链' : '点击查看详情', x + 14, y + height - 18, width - 28);
    }

    this.cardHitAreas.push({ id: task.id, x, y, width, height });
  }

  queuedMeta(task) {
    const remaining = (task.runAfter || 0) - Date.now();
    if (task.attempts === 0) return `新任务 · 优先级 ${PRIORITY_LABELS[task.priority]}`;
    return remaining > 0
      ? `退避 ${Math.ceil(remaining / 1000)}s · 已尝试 ${task.attempts}`
      : `就绪 · 已尝试 ${task.attempts}`;
  }

  drawProgressBar(x, y, width, height, progress, color) {
    this.roundRect(x, y, width, height, height / 2, '#334155', 0.9);
    this.roundRect(x, y, width * (progress / 100), height, height / 2, color, 0.95);
  }

  roundRect(x, y, width, height, radius, color, alpha = 1) {
    if (width <= 0) return;
    const ctx = this.context;
    const r = Math.min(radius, width / 2, height / 2);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
