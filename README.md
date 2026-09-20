# 浏览器韧性任务队列

基于 **IndexedDB + Web Worker + Canvas** 的零依赖任务队列示例，覆盖持久化、优先级、并发消费、指数退避、死信重入、租约恢复和实时可视化。

## 运行

```bash
npm start
# 打开 http://localhost:8080
```

模块 Worker 需要通过 HTTP 提供文件，不建议直接用 `file://` 打开。

## 测试

```bash
npm test
```

测试覆盖退避算法、终态错误、最大尝试次数、优先级排序、租约栅栏、过期恢复和死信重入状态迁移。

## 核心设计

- `src/lib/retry.js`：指数退避 + 等距随机抖动，返回延迟由 `maxDelay` 截断。
- `src/lib/task.js`：任务状态机，状态为 `queued → running → succeeded/retrying/dead`。
- `src/lib/storage.js`：IndexedDB 持久化；领取、写事件、完成都在读写事务中完成。
- `src/workers/consumer-worker.js`：每个 Worker 串行消费，页面启动 4 个 Worker 实现并发。
- `src/ui/chart.js`：Canvas 记录最近 60 个状态快照并实时绘制等待、退避、执行、死信趋势。
- `src/app.js`：控制面板、监控刷新、死信重入、Worker 崩溃监听与自动重启。

## 并发正确性

每个任务领取时生成唯一 `leaseId`。多个 Worker 同时调用 `claimNext` 时，IndexedDB 读写事务保证只有一个事务能把任务从 `queued/retrying` 改成 `running`。Worker 完成任务时必须携带原 `leaseId`，旧 Worker 的迟到结果会被判定为 stale 并拒绝写入。

默认租约为 2500ms，普通长任务每约 833ms 续约一次。模拟崩溃任务不续约，租约到期后由下一轮领取事务恢复为重试；尝试次数耗尽后进入死信。

## 死信判定

- 错误显式标记 `retryable: false`、`terminal` 或 `fatal`，立即进入死信。
- 可重试错误在 `attempts >= maxAttempts` 时进入死信。
- Worker 崩溃导致租约丢失也消耗一次尝试，耗尽后进入死信。
- 死信任务可单条重入或全部重入；重入后重置尝试次数、清理执行租约并累加 `requeueCount`。

## 验收演示

点击“载入验收演示”会创建：

1. 高优先级成功任务；
2. 前两次失败、第三次成功的退避任务；
3. 最大尝试次数较小、最终死信的任务；
4. 不可重试的终态错误；
5. 多层 `cause` 的异常链路；
6. 超过租约周期但靠心跳持续执行的慢任务；
7. Worker 崩溃后租约过期并被其他 Worker 接管的任务。

观察点：

- 高优先级任务先被领取；
- 失败任务状态变为“退避重试”，下次执行时间递增；
- 超限或终态任务进入“死信”；
- 点击死信行“重入”后任务重新进入队列；
- 4 个 Worker 芯片可同时显示不同任务；
- Canvas 与计数每 500ms 从持久化状态刷新；
- 刷新页面后任务与事件仍从 IndexedDB 恢复。
