# 数据所有权与一致性边界

本项目的业务结论必须由 PostgreSQL Run Event Store 重放得到。前端缓存、LangGraph checkpoint、Redis Job、MinIO 对象和本地报告只能作为执行状态或派生存储，不能覆盖机器事实。

| 数据 | 权威来源 | 允许的派生副本 | 恢复规则 |
| --- | --- | --- | --- |
| Run 业务事件 | PostgreSQL `run_control_events` | SQLite 本地开发适配器 | 按 `run_id + version` 重放 |
| Run 当前投影 | PostgreSQL `run_projections` | API/SSE 查询缓存 | 事件重放覆盖缓存 |
| Graph 执行位置 | LangGraph checkpoint | `agent_graph_projection_store` | 以 durable checkpoint 恢复；无法恢复则 blocked |
| Worker Job | Redis/BullMQ | PostgreSQL `event_outbox_v1` | Outbox 重发；同一 `jobId` 幂等 |
| Artifact 元数据 | PostgreSQL `artifacts_v1` | Run bundle 索引 | 没有已提交元数据不能进入 Gate |
| Artifact 文件 | MinIO/S3 | 本地临时文件 | 文件成功但元数据失败时由对账任务处理 |
| 审批与授权 | PostgreSQL Run Event / grants | UI 展示 | 重复请求按 `idempotencyKey` 重放 |
| Trace | Trace Store / `trace_*` 表 | 本地脱敏报告 | 缺失 Trace 只能降低可观测性，不得提升 Gate |
| Experience Memory | Memory Store | Planner 检索结果 | 必须携带 `sourceRunId`/`runId`，不能覆盖当前项目事实 |

## Outbox 规则

`permission_granted`、`run_resumed` 和 `run_retrying` 等 Worker-owned 事件，在同一个 PostgreSQL 事务中写入 `event_outbox_v1`。Redis 投递成功后再标记 `published`；API 或 Worker 重启时由轮询器重新发送 `pending`/超时 `publishing` 记录。

`agent/tests/outboxStore.test.ts` 覆盖最小崩溃窗口：事务已留下 Outbox、队列首次投递失败时记录必须回到 `pending`；重试成功后只允许一次 `published` 投递。该测试不替代 PostgreSQL/Redis/MinIO 的服务级故障演练，后者仍由生产验收与故障注入矩阵负责。

动态浏览器 parent 由 Worker outbox 投递后，只负责按 CoverageItem 创建 child；每个动态 page child 是 Graph-owned 执行路径，不写入自己的 Worker execute outbox，避免 API/Worker 竞争同一 Browser Graph。Manifest/API/Data/Command path 则由 Worker outbox 投递。

业务模块通过 [databaseRuntime.ts](../agent/src/databaseRuntime.ts) 借用进程级 Pool，不得自行创建或关闭 PostgreSQL Pool。连接数、等待数和空闲数由 `databasePoolStats()` 暴露给健康检查或监控层。

## 不变量

- Outbox 重复投递不得产生第二个业务结果。
- PostgreSQL 事件已提交但 Redis 失败时，Run 不得被标记为执行成功；Outbox 必须保持可重试。
- MinIO 文件没有 PostgreSQL Artifact 元数据时，不能成为正式 Evidence。
- Worker 启动后及每 `ARTIFACT_RECONCILE_INTERVAL_MS` 会扫描 `ARTIFACT_S3_PREFIX`。对象在 24 小时元数据提交宽限期后仍没有 PostgreSQL `artifacts_v1` 引用、或临时上传对象保留超过 1 小时，才可自动删除；这避免将“对象已写入、元数据事务尚未完成”的短暂窗口误删。
- 已登记对象若在 MinIO/S3 中缺失、大小不符或 SHA-256 元数据不符，会被标记 `objectStoreState=missing`。API 再读取该 Run 时将 Machine Gate 强制降为 `blocked`；不可变的历史 Run Bundle 保留原始捕获事实，但不能再作为当前发布结论依据。

## Artifact 对账操作

生产 Worker 自动以安全宽限期执行对账。运维也可先查看计划，再显式应用：

```bash
npm --workspace @ai-test-officer/agent run artifact:reconcile
npm --workspace @ai-test-officer/agent run artifact:reconcile -- --apply
```

该命令必须同时配置 `DATABASE_URL`、`ARTIFACT_S3_BUCKET`、S3 凭据和端点；默认 dry-run，只有 `--apply` 才会更新缺失状态或清除已经过宽限期的孤儿对象。
- 旧 Worker 的 `workerAttemptId` 或 `executionGeneration` 不匹配时必须被拒绝。
- Machine Gate 只能读取当前 Run、Scenario、Attempt 和已提交 Artifact。
