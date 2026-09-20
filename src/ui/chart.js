const STATUS_STYLES = {
  queued: { label: '等待', color: '#60a5fa' },
  retrying: { label: '退避', color: '#fbbf24' },
  running: { label: '执行', color: '#34d399' },
  succeeded: { label: '成功', color: '#22c55e' },
  dead: { label: '死信', color: '#f87171' }
};

export class MonitorChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.history = [];
    this.maxSamples = 60;
    this.resizeObserver = new ResizeObserver(() => this.draw(this.lastSnapshot));
    this.resizeObserver.observe(canvas);
  }

  push(snapshot) {
    this.lastSnapshot = snapshot;
    this.history.push(snapshot);
    if (this.history.length > this.maxSamples) this.history.shift();
    this.draw(snapshot);
  }

  draw(snapshot = { counts: {}, runningWorkers: 0 }) {
    const { width, height } = this.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = width * ratio;
    this.canvas.height = height * ratio;
    const ctx = this.context;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const labels = ['queued', 'retrying', 'running', 'succeeded', 'dead'];
    const total = labels.reduce((sum, key) => sum + (snapshot.counts?.[key] || 0), 0);
    const left = 46;
    const right = 16;
    const top = 18;
    const chartHeight = 132;
    const chartWidth = Math.max(50, width - left - right);

    drawGrid(ctx, left, top, chartWidth, chartHeight);
    if (this.history.length > 0) {
      drawSeries(ctx, this.history, { left, top, chartWidth, chartHeight, total: Math.max(total, 1) });
    }

    const legendY = top + chartHeight + 28;
    labels.forEach((key, index) => {
      const style = STATUS_STYLES[key];
      const x = left + index * 92;
      ctx.fillStyle = style.color;
      ctx.fillRect(x, legendY - 10, 10, 10);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '12px system-ui';
      ctx.fillText(`${style.label} ${snapshot.counts?.[key] || 0}`, x + 15, legendY);
    });

    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`活跃 Worker: ${snapshot.runningWorkers || 0}`, width - 126, legendY);
  }
}

function drawGrid(ctx, left, top, width, height) {
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.lineWidth = 1;
  for (let row = 0; row <= 4; row += 1) {
    const y = top + (height / 4) * row;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + width, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  ctx.strokeRect(left, top, width, height);
}

function drawSeries(ctx, history, bounds) {
  const { left, top, chartWidth, chartHeight, total } = bounds;
  const keys = ['queued', 'retrying', 'running', 'dead'];
  const step = chartWidth / Math.max(1, 59);
  const getY = (value) => top + chartHeight - (value / total) * chartHeight;

  keys.forEach((key) => {
    ctx.beginPath();
    history.forEach((snapshot, index) => {
      const x = left + index * step;
      const y = getY(snapshot.counts[key] || 0);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = STATUS_STYLES[key].color;
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  const latest = history[history.length - 1];
  if (latest) {
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px system-ui';
    ctx.fillText(`总任务: ${total}`, left, top - 5);
  }
}
