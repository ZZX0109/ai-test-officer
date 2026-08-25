# 生产 SLO、告警与故障处置手册

本手册只描述已经实现、可观测的运行面；它不是尚未完成的外部盲测或多模型评测的替代证据。

## SLO 查询入口

`GET /api/operations/slo` 返回不含 Run ID、Artifact URI、凭据或用户数据的低基数计数，适合由 Prometheus/Datadog/云监控适配器定期抓取：

Prometheus-compatible deployments can scrape `GET /api/operations/slo/prometheus`; the ready-to-install rule and dashboard templates are in `deploy/observability/`.

```json
{
  "slo": {
    "metrics": {
      "stalledRuns": 0,
      "pendingOutbox": 0,
      "stalePublishingOutbox": 0,
      "missingArtifactReplicas": 0,
      "expiredLeases": 0,
      "databaseWaitingClients": 0
    },
    "alerts": []
  }
}
```

告警策略：`stalledRuns`、`missingArtifactReplicas`、`stalePublishingOutbox` 任一大于零为 critical；`expiredLeases` 或连接池等待大于零为 warning；待投递 Outbox 达到 20 为 warning。SLO 查询未配置数据库或查询失败时产生 `slo_unavailable` critical，不能把空指标视为健康。外部告警平台应对 critical 建立即时通知，对 warning 建立值班工单。

## 处置步骤

| 告警 | 先做什么 | 恢复判据 |
| --- | --- | --- |
| `stalled_runs` | 查询 Run 事件、Graph checkpoint 和 Worker 日志；确认 Lease/Generation。若 Run 停在 `judging` 且已超过 `JUDGING_RECOVERY_GRACE_MS`，只根据持久化 Machine Gate 落终局，不重投递路径；若 Run 为 `awaiting-permission` 且 Graph 仍为 `plan-approval`，等待 `PLAN_APPROVAL_RESUME_RECOVERY_GRACE_MS` 后由恢复器继续到权限边界 | Gate 场景到达唯一 terminal disposition；审批场景保持唯一 `plan_approved`，Graph 到达 `browser-permission`，没有自动授予能力 |
| `outbox_stale_publishing` / `outbox_backlog` | 检查 Redis、Worker 和 `event_outbox_v1`；不要手工伪造已发布状态 | Publisher 重试后 Outbox 为 `published`，同一 `jobId` 没有重复副作用 |
| `artifact_replica_missing` | 保留 PostgreSQL 元数据和不可变 Bundle，检查 MinIO 生命周期/权限；必要时从受控备份恢复对象 | 对账将对象校验为 `committed`；在此之前 API 必须持续显示 `blocked` |
| `expired_leases` | 检查 Worker 重启/网络中断；让有效代次接管，旧 Worker 结果必须被 fencing 拒绝 | 写入 `worker_lease_expired` 的 `run_retrying` 事件并产生新 Outbox 版本，最终只有一个 terminal outcome；不遗留 `running` |
| `database_pool_waiting` | 检查连接上限、慢查询和泄露；只通过共享 `databaseRuntime` 调整池配置 | `waitingCount` 回到零且 API/Worker 健康检查稳定 |
| `slo_unavailable` | 检查 `DATABASE_URL`、数据库连通性、迁移状态和监控接口日志；在恢复前保持发布阻断 | `/api/operations/slo` 不再返回 `unavailableReason`，且能读取真实持久化计数 |

## 对账与演练

Artifact 对账默认由 Worker 每 15 分钟执行，可用以下命令先审计后应用：

```bash
npm --workspace @ai-test-officer/agent run artifact:reconcile
npm --workspace @ai-test-officer/agent run artifact:reconcile -- --apply
```

生产 Compose 验收 `npm run acceptance:production` 已自动演练：Worker/API/Redis/PostgreSQL/MinIO 重启、运行中的 Worker 收到 `SIGKILL` 并由编排器拉起替代进程后恢复、`plan_approved` 已提交但 Graph 尚未推进时的 API `SIGKILL`（恢复到 `browser-permission` 而不自动授权）、Gate 已提交但 Graph checkpoint 尚未推进时的 Worker `SIGKILL`（之后以持久化 Gate 唯一终结，并通过新 SSE 连接重放）、Worker 控制网络断开并重连、客户端 SSE 断流后以查询恢复、重复投递、过期 Lease、Outbox 恢复、以及“提交后的对象副本被删除”。最后一个场景必须令 Machine Gate 和最终结论都变为 `blocked`。

该验收尚未取代完整的八个动作级崩溃时点、长时间 Worker 网络隔离、乱序/延迟消息和其余 SSE 重放矩阵；这些仍是发布前需补充的可靠性测试。
