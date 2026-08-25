# 可靠性与故障注入矩阵

本矩阵区分“已在隔离 Production Compose 中实际执行”的黑盒故障，与尚未具备精确进程崩溃点的边界。未标记为通过的项目不得作为发布完成证据。

| 目标边界 | 自动化证据 | 当前状态 | 保证范围 |
| --- | --- | --- | --- |
| 执行已开始、Worker 硬杀 | `worker_sigkill_running_recovery` | 通过 | Lease 到期后写入 `run_retrying`、新的 Outbox 版本完成 Run；旧 generation 被拒绝，且 Child Run 只有一个 terminal outcome。重试 Attempt 会保留用于审计。 |
| State 写入后、Worker 接收前 | `pause_resume_worker_restart` | 通过 | 已入队 Run 在 Worker 停止期间不执行；恢复后以新版本继续。 |
| Queue 已发送、控制网络中断 | `worker_network_disconnect_recovery` | 通过 | PostgreSQL Outbox 保持权威投递记录，网络恢复后完成。 |
| API 在排队期重启 | `queued_run_agent_api_restart_recovery` | 通过 | API 不拥有业务结果；Graph/Worker 能从持久化状态继续。 |
| 重复 Job、旧 Worker 或 Lease 过期 | `duplicate_permission_delivery`、`expired_lease_takeover`、`active_attempt_unique` | 通过 | 同一版本不会造成第二份持久化 Attempt；过期 Lease 可接管。 |
| Redis、PostgreSQL、MinIO 故障 | `redis_reconnect_delivery`、`postgres_api_worker_restart_recovery`、`minio_unavailable_blocks_commit` | 通过 | 连接/投递恢复；对象存储不可用时不能形成通过结论。 |
| 已提交对象随后丢失 | `artifact_reconciliation_blocks_stale_replica` | 通过 | 对账将 Artifact 和 Machine Gate 降级为 `blocked`，并触发 critical SLO。 |
| SSE 客户端断流 | `sse_disconnect_query_recovery` | 通过 | SSE 仅为投影；客户端重新查询得到持久化真实状态。 |
| 可变 API 执行后、回执写入前的精确崩溃 | `mutable_api_post_effect_sigkill_recovery`、`mutable_api_post_effect_single_side_effect` | 通过 | 未声明请求键和响应回显契约的 `POST/PUT/PATCH/DELETE` 在网络调用前阻断。真实幂等目标端已在成功响应、回执完成前暂停并 SIGKILL API 服务；以同一 `runId + actionId + operationId` 重试时，目标端仍只有一次写入，PostgreSQL 回执由 `pending` 完成至 `completed`。 |
| Artifact 临时上传完成、临时对象校验完成时的 Worker 硬杀 | `artifact_temporary_upload_sigkill_recovery`、`artifact_temporary_upload_orphan_reconciled`、`artifact_temporary_verified_sigkill_recovery`、`artifact_temporary_verified_orphan_reconciled` | 通过 | 分别在 `PutObject` 后和临时 `HeadObject` 校验后精确暂停并 SIGKILL。每个恢复 Attempt 终局后，以零宽限期的验收对账确认首次 Attempt 留下的 `.partial` 对象被删除。 |
| 最终对象已提交、Artifact ledger 元数据尚未写入时的 Worker 硬杀 | `artifact_object_commit_sigkill_recovery`、`artifact_object_commit_orphan_reconciled`、`artifact_object_commit_no_orphan_adoption` | 通过 | 在 S3 `CopyObject` + `HeadObject` 校验后、`artifacts_v1` 写入前精确暂停并 SIGKILL。恢复 Attempt 完成；首次的无引用最终对象由对账删除，且不会被 Artifact ledger 或 Gate 采用。测试钩子以数据库一次性领取回执避免恢复 Worker 再次暂停。 |
| Gate 写入后、Graph checkpoint/SSE 发送前的 Worker 硬杀 | `gate_sse_post_commit_sigkill_recovery`、`gate_sse_post_commit_recovery_trace`、`gate_sse_post_commit_sse_replay` | 通过 | `run_judging` 已提交后硬杀 Worker；超过 `JUDGING_RECOVERY_GRACE_MS` 的停滞 `judging` 投影只依据已提交 Machine Gate 落一个终局事件，不重跑路径。事后新建 SSE 能重放该 Gate 事件，且不存在孤儿 Lease。 |
| 人工审批写入后、Graph resume 前的 API 硬杀 | `approval_post_commit_sigkill_recovery`、`approval_post_commit_graph_resume`、`approval_post_commit_single_approval` | 通过 | `plan_approved` 已提交后硬杀 API；超过 `PLAN_APPROVAL_RESUME_RECOVERY_GRACE_MS` 的停滞 `plan-approval` Graph checkpoint 由原子认领的恢复器推进到 `browser-permission`。不会补写批准事件，也不会跳过显式能力授权。 |
| 乱序与显式延迟消息 | `queue_out_of_order_generation_fence`、`queue_delayed_delivery_single_terminal` | 通过 | Worker 停止时注入立即到达的旧 generation 与延迟到达的当前 generation。恢复后只允许一个 Child Run 和一个父 Run 终局；延迟消息到达后版本和状态保持不变。 |

每次已通过的恢复场景都必须在 Run Event Store 中留有事件链；例如执行期 Worker 硬杀恢复会产生原因 `worker_lease_expired` 的 `run_retrying` 事件，Gate 后 checkpoint 丢失会产生 `stalled_judging_checkpoint_after_gate_commit` 的终局恢复原因，而审批恢复必须保持唯一的 `plan_approved` 事件。生产 SLO 和运行手册只将上表的“通过”行计为已验证能力。

运行 `npm run fault:injection:audit` 会读取最近一次隔离 Production Compose 验收的检查清单，把上表对应的 14 个崩溃边界映射到 `reports/fault-injection/latest.json` 和 `.md`，并在任一检查缺失时 fail-closed。报告中的覆盖率是已执行黑盒断言的覆盖率，不是长期生产恢复率。
