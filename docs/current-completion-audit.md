# 当前目标书逐项审计

更新时间：2026-08-25。本文把“代码已经存在”“本地测试通过”和“目标书要求的外部证据”分开记录。没有报告或外部输入的项目不标记为完成。

## 状态摘要

| 目标书项目 | 当前判断 | 证据 / 缺口 |
| --- | --- | --- |
| P0-1 干净 Linux 基线 | Clean-build 矩阵完成；完整验收矩阵仍部分完成 | `reports/baseline-verification/linux-latest.json` 在 `git archive HEAD` 的干净 `linux/arm64` 容器中记录了 install、lint、diff、size、quality、typecheck、build、浏览器可用性和全量 test 共 9/9 通过。该容器没有 Docker-in-Docker，因此 production-acceptance、fault-injection、Workbench E2E、unified run、credibility browser 和 benchmark 仍须由各自隔离报告证明，不能被这 9 步替代。 |
| P0-2 God File 拆分 | 代码门禁完成，职责迁移仍可继续 | 四个基线和 50% 上限已写入 `scripts/god-file-baselines.json`，`size-guard` 会阻止回退；新增/未跟踪源码超过 800 行也会失败。当前 `App.tsx` 3,172、`server.ts` 1,544、`agentGraphService.ts` 1,264、`testRunner.ts` 1,181 行均在门限内，Run control 路由已迁移到独立模块。完整职责审查仍以模块责任表为准。 |
| P0-3 Typed Subgraph | 代码级完成 | `docs/typed-subgraphs.md`、`packages/agent-orchestration/src/subgraphs.ts`、状态 Contract、直接子图测试和当前 `shadow:run` 100/100。Shadow 只证明编排拓扑，不证明外部项目泛化。 |
| P0-4 数据所有权/一致性 | 代码级完成，隔离服务故障证据完成 | `docs/data-ownership.md`、Shared Database Runtime、Transactional Outbox、幂等 Consumer、Artifact 对账实现和生产摘要；Data Executor、Readiness 检查已统一借用共享 Pool；生产 Compose 验收已覆盖 PostgreSQL/Redis/MinIO 重启与恢复，仍不等同持续生产演练。 |
| P0-5 Experience Memory | 明确降级完成 | 默认模式是 `deterministic-hash-v0`，对外标记 `semantic: false`，并提供 `Recall@5/10`、MRR 等评测接口；已补齐 `data/memory/retrieval-eval-v1.json` 的 50 条标签集和完整性门禁，但尚未接入真实 Embedding 或运行 Provider 评测。 |
| P0-6 Runtime Binding/全面扫描 | 控制面与 Child 规格证据完成，真实执行规模仍待外部负载 | `runtimeBinding`、CoverageItem disposition、Parent/Child Run、独立预算和外部项目动态发现 smoke 已存在；`reports/capacity-control-plane/latest.json` 现在还验证每条 200 路径都有唯一 Child Run 规格、独立预算、Silent Drop Rate 0。该报告仍不是 200 个浏览器/Worker 实际执行的生产负载证据。 |
| P0-7 故障注入 | 隔离 Production Compose 矩阵完成，长期/生产统计仍待补 | `scripts/production-acceptance.mjs` 覆盖多类 SIGKILL、Outbox、Lease、Artifact 和幂等写入；`scripts/fault-injection-audit.mjs` 将 14 个目标崩溃窗口映射到 `reports/fault-injection/latest.json`，输出场景覆盖率、恢复证明覆盖率、重复副作用证明覆盖率和孤儿对账证明覆盖率。该报告仍不等同持续生产 SLO 或外部项目故障注入。 |
| P0-8 外部真实项目/盲测 | 原生预检完成，正式盲测未完成 | 五个锁定项目的 provenance、原生检查和 lane 记录都存在，但 `reports/external-acceptance/latest.json` 的 fail-closed 审计为 `passed=false`：全部非原生 lane 停在 `waiting-user / needs-human-review`，密封 evaluator 报告目录未配置，且部分证据自身声明没有挂载密封标签或比较 lane。审计现在要求每个 lane 的终态记录以及仓库外 evaluator 报告的哈希和 run 绑定，不能再由自报字段升级为通过。 |
| P1-1 性能/容量 | 部分完成 | Control-plane 1/10/50 × 10/50/200 矩阵保持 Silent Drop Rate 0；另有数据服务 10/50/200 并发的 Postgres/Redis/MinIO 报告、Worker 100 次/C20、浏览器 100 Context/C10 及一次 Postgres-backed 50 次/C10 创建负载。它们是实测局部指标，但 MinIO 仅测健康端点、Worker 测创建而非完成、也未构成目标书完整的多档端到端生产容量矩阵。 |
| P1-2 安全/Prompt Injection/多租户 | 本地对抗和 23 条隔离红队 probe 完成；真实生产租户仍待 | `security-adversarial` 覆盖输入与授权矩阵；`redteam/` 报告了 sandbox escape 12、malicious OCI 4、provider isolation 7 条 probe 全部 blocked。它们运行在隔离测试环境，不能证明真实生产租户/第三方 Provider 的持续安全态势。 |
| P1-3 Repair 安全 | 生命周期接口与导出证据存在，生产级 Repair 未证明 | 五个外部 repair session 均导出了 patch，报告中的副作用率为 0；但五个 validation 中四个 blocked、一个 failed，`filesWritten` 都是 0，`rollbackAvailable` 只是可用性断言而非本轮回滚验证。因此不能写 successRate=1 或把它当作真实安全修复成功率。 |
| P1-4 Trace/评测/生产 SLO | 合约/模板完成，隔离 Compose 一次测量完成，持续生产证据仍待 | 50 次/C10 的 Postgres-backed 运行创建负载记录 50/50、P50 48ms、P95 295ms、P99 303ms；Prometheus 规则与 6 panel 模板做了结构交叉引用。测量栈是一次性 Compose，告警未接 PagerDuty/Slack，Grafana 未实装，且不等同于长期目标生产 SLO。 |

## 已有可复核入口

- Typed Subgraph：`docs/typed-subgraphs.md`
- 数据所有权：`docs/data-ownership.md`
- 模块职责：`docs/module-responsibilities.md`
- 安全威胁模型：`docs/security-threat-model.md`
- 运行手册：`docs/operations-runbook.md`
- 100 次 Shadow Graph：`reports/shadow-graph/latest.json`
- Control-plane 容量矩阵：`reports/capacity-control-plane/latest.json`（不等同生产容量）
- 故障注入矩阵审计：`reports/fault-injection/latest.json`（隔离 Compose 场景覆盖，不等同生产 SLO）
- Prompt Injection 对抗矩阵：`reports/security-adversarial/latest.json`（不等同恶意 OCI/生产租户演练）
- Memory 50 条标签集：`data/memory/retrieval-eval-v1.json`；完整性检查：`npm run memory:eval:dataset`
- 统一基线报告：`reports/baseline-verification/latest.md`（下一次 `baseline:verify` 同时生成固定名 `baseline-verification-report.md`）
- 干净 Linux 9/9：`reports/baseline-verification/linux-latest.json` 和 `linux-report.md`
- 外部盲测 fail-closed 审计：`reports/external-acceptance/latest.md`
- 隔离红队：`reports/redteam/`
- Repair 外部会话：`reports/external-repair/latest.json`
- 一次性生产 SLO 测量：`reports/production-slo/latest.json`（交付包会移除生成密钥）
- 生产验收摘要：`reports/production-acceptance/latest.json`
- 外部审阅交接：`docs/review-handoff.md`

## 本轮新增的反例保护

`agent/tests/proofBundleValidator.test.ts` 和 `agent/tests/proofGraph.test.ts` 现在覆盖：跨 Attempt 注入、fixture-only artifact、悬空 artifact ref、未执行 Oracle、完整截图下的业务断言失败、Judge pass 不能覆盖 Machine Gate fail，以及缺少 reviewer/reason 的人类覆盖请求。`npm run typecheck`、`npm --workspace @ai-test-officer/agent test` 和 `npm run lint -- --quiet` 已在当前 checkout 通过。

## 结论

当前仓库已经完成大部分 P0 的代码级收敛，并能证明干净 Linux 9/9、若干本地/fixture/隔离 Compose 行为；但目标书的最终完成定义仍未满足。尤其不能用 Synthetic Shadow、停在人工审批前的 lane、局部负载、单个外部 smoke 或一次性 Compose 测量替代五个异构真实项目的密封盲测、完整端到端容量矩阵、可验证 Repair、持续生产红队和 SLO 证据。
