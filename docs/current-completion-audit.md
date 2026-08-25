# 当前目标书逐项审计

更新时间：2026-08-24。本文把“代码已经存在”“本地测试通过”和“目标书要求的外部证据”分开记录。没有报告或外部输入的项目不标记为完成。

## 状态摘要

| 目标书项目 | 当前判断 | 证据 / 缺口 |
| --- | --- | --- |
| P0-1 干净 Linux 基线 | 部分完成 | `reports/baseline-verification/latest.json` 记录过 Linux 安装、构建、主测试、Workbench、统一运行、可信度浏览器、出口代理和外部 smoke；Benchmark 缺少外部模型凭证/实验 ID，嵌套 Docker 的 Compose 构建未进入生产断言。当前 checkout 的 `typecheck`、Agent 全量测试和 lint 已重新通过，但工作树本身是有意修改态，不能冒充 clean-baseline。 |
| P0-2 God File 拆分 | 代码门禁完成，职责迁移仍可继续 | 四个基线和 50% 上限已写入 `scripts/god-file-baselines.json`，`size-guard` 会阻止回退；新增/未跟踪源码超过 800 行也会失败。当前 `App.tsx` 3,172、`server.ts` 1,544、`agentGraphService.ts` 1,264、`testRunner.ts` 1,181 行均在门限内，Run control 路由已迁移到独立模块。完整职责审查仍以模块责任表为准。 |
| P0-3 Typed Subgraph | 代码级完成 | `docs/typed-subgraphs.md`、`packages/agent-orchestration/src/subgraphs.ts`、状态 Contract、直接子图测试和当前 `shadow:run` 100/100。Shadow 只证明编排拓扑，不证明外部项目泛化。 |
| P0-4 数据所有权/一致性 | 代码级完成，隔离服务故障证据完成 | `docs/data-ownership.md`、Shared Database Runtime、Transactional Outbox、幂等 Consumer、Artifact 对账实现和生产摘要；Data Executor、Readiness 检查已统一借用共享 Pool；生产 Compose 验收已覆盖 PostgreSQL/Redis/MinIO 重启与恢复，仍不等同持续生产演练。 |
| P0-5 Experience Memory | 明确降级完成 | 默认模式是 `deterministic-hash-v0`，对外标记 `semantic: false`，并提供 `Recall@5/10`、MRR 等评测接口；已补齐 `data/memory/retrieval-eval-v1.json` 的 50 条标签集和完整性门禁，但尚未接入真实 Embedding 或运行 Provider 评测。 |
| P0-6 Runtime Binding/全面扫描 | 控制面与 Child 规格证据完成，真实执行规模仍待外部负载 | `runtimeBinding`、CoverageItem disposition、Parent/Child Run、独立预算和外部项目动态发现 smoke 已存在；`reports/capacity-control-plane/latest.json` 现在还验证每条 200 路径都有唯一 Child Run 规格、独立预算、Silent Drop Rate 0。该报告仍不是 200 个浏览器/Worker 实际执行的生产负载证据。 |
| P0-7 故障注入 | 隔离 Production Compose 矩阵完成，长期/生产统计仍待补 | `scripts/production-acceptance.mjs` 覆盖多类 SIGKILL、Outbox、Lease、Artifact 和幂等写入；`scripts/fault-injection-audit.mjs` 将 14 个目标崩溃窗口映射到 `reports/fault-injection/latest.json`，输出场景覆盖率、恢复证明覆盖率、重复副作用证明覆盖率和孤儿对账证明覆盖率。该报告仍不等同持续生产 SLO 或外部项目故障注入。 |
| P0-8 外部真实项目/盲测 | 原生预检完成，正式盲测未完成 | `scripts/external-project-preflight.mjs` 已在五个锁定 revision 上生成项目级证据：ANDFlow 原生测试通过、Next.js 构建通过、investment 项目原生 Python/JS 测试存在失败、FastAPI 受 Python/依赖环境阻断、Spring 受 Java/Maven/依赖网络阻断。`reports/external-acceptance/latest.md` 现在明确记录每个项目的缺失 lane；规则/LLM 五通道、两模型三重复、密封标签和 evaluator 隔离仍未执行。 |
| P1-1 性能/容量 | 部分完成 | `agent/tests/capacityMatrix.test.ts` 已对真实 CoverageItem 创建和 Parent dispatch 执行 1/10/50 × 10/50/200 control-plane 矩阵，并写出 `reports/capacity-control-plane/latest.json`，Silent Drop Rate 为 0；该报告明确不等同 Docker/PostgreSQL/Redis/Worker/MinIO/浏览器的生产容量和 P95/P99 证据。 |
| P1-2 安全/Prompt Injection/多租户 | 本地对抗与授权矩阵完成，真实环境红队仍待 | `agent/tests/securityAdversarialMatrix.test.ts` 覆盖 requirement、diff、DOM、network、OpenAPI、artifact 注入，以及跨项目 Artifact、viewer 执行、过期 Grant；报告写出 `reports/security-adversarial/latest.json`。Proof Bundle 还会拒绝悬空 artifact 引用、未执行 Oracle、跨 Run/Attempt 证据和 fixture-only 截图。恶意项目、真实多租户部署和 Provider 隔离仍未执行。 |
| P1-3 Repair 安全 | 代码测试部分完成 | Repair sandbox、Patch/Validation Child Run、Write Safety 和恢复测试存在；缺跨真实项目的副作用率与回归报告。 |
| P1-4 Trace/评测/生产 SLO | 合约与部署模板完成，生产证据仍待 | Trace 已支持结构化 Run/Project/Scenario/Attempt/Step 与 Model/Prompt/Commit/Token/Cost/Latency 元数据；`/api/operations/slo/prometheus`、Prometheus 规则和 Grafana 仪表盘模板已落地。尚无目标生产环境的实际 SLO 数值、告警记录、100 次 Shadow Graph 之外的真实评测和已安装看板证据。 |

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
- 生产验收摘要：`reports/production-acceptance/latest.json`
- 外部审阅交接：`docs/review-handoff.md`

## 本轮新增的反例保护

`agent/tests/proofBundleValidator.test.ts` 和 `agent/tests/proofGraph.test.ts` 现在覆盖：跨 Attempt 注入、fixture-only artifact、悬空 artifact ref、未执行 Oracle、完整截图下的业务断言失败、Judge pass 不能覆盖 Machine Gate fail，以及缺少 reviewer/reason 的人类覆盖请求。`npm run typecheck`、`npm --workspace @ai-test-officer/agent test` 和 `npm run lint -- --quiet` 已在当前 checkout 通过。

## 结论

当前仓库已经完成大部分 P0 的代码级收敛，并能证明若干本地/fixture/生产 Compose 行为；但目标书的最终完成定义仍未满足。尤其不能用 Synthetic Shadow、单个外部 smoke 或 45 项生产摘要替代五个异构真实项目、密封盲测、容量矩阵、安全对抗和生产 SLO 证据。
