import { TaskError } from './queue-policy.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const TASK_TYPES = Object.freeze([
  { value: 'demo', label: '演示任务' },
  { value: 'flaky', label: '间歇失败' },
  { value: 'slow', label: '慢速任务' },
  { value: 'fatal', label: '不可重试' },
  { value: 'dependency', label: '异常链路' }
]);

async function runDemo(task, { emitProgress }) {
  const steps = 4;
  for (let step = 1; step <= steps; step += 1) {
    await sleep(120);
    emitProgress(task.id, Math.round((step / steps) * 100), `处理步骤 ${step}/${steps}`);
  }
  return { finishedAt: Date.now(), echo: task.payload.value ?? null };
}

async function runFlaky(task, { emitProgress }) {
  const failBefore = Number(task.payload.failBefore ?? 2);
  await sleep(240 + Math.random() * 260);
  emitProgress(task.id, 70, `第 ${task.attempts} 次尝试`);
  if (task.attempts < failBefore) {
    throw new TaskError(`外部服务临时不可用，需要第 ${task.attempts + 1} 次尝试`, {
      name: 'TemporaryUnavailableError',
      code: 'SERVICE_503'
    });
  }
  return { recovered: true, attempts: task.attempts };
}

async function runSlow(task, { emitProgress }) {
  const duration = Number(task.payload.duration ?? 2500);
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    await sleep(duration / steps);
    emitProgress(task.id, Math.round((step / steps) * 100), `长任务执行中 ${step}/${steps}`);
  }
  return { duration };
}

async function runFatal(task) {
  await sleep(180);
  throw new TaskError(`参数格式无效：${task.payload.field ?? 'unknown'}`, {
    name: 'ValidationError',
    code: 'INVALID_PAYLOAD',
    nonRetryable: true
  });
}

async function runDependency(task) {
  await sleep(300);
  const networkError = new TypeError('Failed to fetch: socket hang up');
  networkError.name = 'NetworkError';
  networkError.cause = {
    name: 'SocketError',
    message: 'ECONNRESET',
    code: 'ECONNRESET'
  };

  throw new TaskError('支付渠道调用失败', {
    cause: networkError,
    name: 'PaymentDependencyError',
    code: 'PAYMENT_PROVIDER_FAILED'
  });
}

const handlers = new Map([
  ['demo', runDemo],
  ['flaky', runFlaky],
  ['slow', runSlow],
  ['fatal', runFatal],
  ['dependency', runDependency]
]);

export async function runTask(task, context) {
  const handler = handlers.get(task.type);
  if (!handler) {
    throw new TaskError(`未知任务类型：${task.type}`, {
      name: 'UnknownTaskTypeError',
      code: 'UNKNOWN_TASK_TYPE',
      nonRetryable: true
    });
  }
  return handler(task, context);
}
