# IndexedDB + Web Worker + Canvas 可靠任务队列

零依赖浏览器示例，演示持久化任务队列的核心可靠性能力。

## 运行

```bash
npm start
# 打开 http://localhost:5173
```

Worker 使用 ES Module，不能通过直接双击 `index.html` 的 `file://` 方式运行。

## 测试

```bash
npm test
```

测试覆盖退避、优先级选择、最大尝试、不可重试异常、成功释放租约、崩溃租约恢复、死信重入和异常链序列化。

## 验收点对应

- **任务重试与退避**：`js/queue-policy.js` 使用指数退避和等宽随机抖动，公式为 `delay = min(maxDelay, baseDelay * factor^(attempt-1)) * random`。
- **死信判定**：可重试异常达到 `maxAttempts` 后进入死信；标记为 `nonRetryable` 或 `retryable:false` 的异常首次失败即进入死信。
- **死信重入**：单个死信任务或全部死信任务可重置 `attempts`、租约和退避后重新排队，同时保留历史 `errorChain` 与审计生命周期。
- **优先级**：排序为优先级升序、到期时间升序、创建时间升序、ID 兜底；高优先级到期任务总是先被领取。
- **并发消费**：Worker 维护活动任务集合，默认 3 个消费者槽，可在 1–8 之间动态调整。
- **异常链路**：支持标准 `cause`、`AggregateError.errors`、普通对象抛出值、循环引用保护和截断堆栈。
- **持久化与崩溃恢复**：任务状态先在 IndexedDB 中从事务内改成 `running` 并写入租约，再执行业务；每 1 秒续租，超过 15 秒未续租会被重新排队。
- **实时可视化**：Canvas 按等待/退避、并发消费、成功、死信四列展示任务卡片、倒计时、尝试次数、执行进度和并发槽。

## 文件结构

- `index.html`：操作栏、Canvas 和详情/事件侧栏。
- `styles.css`：深色监控台样式。
- `js/queue-policy.js`：纯策略模块，无浏览器 API，可直接被 Node 测试。
- `js/idb.js`：IndexedDB schema、原子领取、状态流转、租约和死信操作。
- `js/task-handlers.js`：演示任务类型，包括临时失败、不可重试、慢速长任务和嵌套异常。
- `js/worker.js`：调度循环、并发槽、租约心跳、快照和命令处理。
- `js/dashboard.js`：Canvas 看板渲染与点击命中测试。
- `js/app.js`：UI 表单、Worker 通信、任务详情和事件日志。

## 演示任务

- `demo`：稳定成功，展示步骤进度。
- `flaky`：按 `payload.failBefore` 在前几次尝试失败，成功后展示实际尝试次数。
- `slow`：长时间运行，验证 1 秒租约心跳和实时进度。
- `fatal`：不可重试参数异常，首次失败直接死信。
- `dependency`：嵌套依赖异常，展示完整异常链路；默认 2 次后因重试上限死信。

点击“生成演示”会创建不同优先级和失败模式的任务。刷新页面后任务仍然存在，`running` 租约超时后会自动回到队列。
