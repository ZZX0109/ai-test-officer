# 模块责任与架构边界

本文记录 P0-2 重构后的责任边界。它是代码审查和后续迁移的依据，不把尚未完成的事项描述为已验收能力。

```text
HTTP request
  -> server.ts（进程装配、全局安全中间件、遗留兼容路由）
  -> server/routes/*（请求解析、访问校验、HTTP 响应）
  -> service / domain module（业务流程、持久化、执行编排）
  -> PostgreSQL / Outbox / object storage / worker

Run request
  -> runner/scenarioExecution（受控浏览器与已编译动作执行）
  -> runner/runFinalization（Artifact、Evidence、Judge、Machine Gate、Proof Bundle）
  -> evidence/proof stores（可复核的持久化结果）
```

## Server

| 模块 | 唯一责任 | 明确不负责 |
| --- | --- | --- |
| `agent/src/server.ts` | Express 进程装配、全局认证/限流/错误处理及少量未迁移兼容入口 | 在路由内实现浏览器、Repair、SSE 或 Proof 业务流程 |
| `server/routes/run-creation.routes.ts` | 创建 Durable Run、组织/项目授权、确认执行后的 Planning hand-off 及 Graph 启动 | 直接生成 Gate 结论、绕过 Run Event Store 或在 HTTP 层执行浏览器动作 |
| `server/routes/run-control.routes.ts` | Plan approval、权限、暂停/恢复/取消、决策覆盖和 benchmark timeout 的 Durable Run 控制入口 | 绕过 Run Event Store、直接改写状态或替代 Graph 恢复语义 |
| `server/routes/run-inspection.routes.ts` | Run、浏览器会话、恢复、Coverage、LLM 调用和 Proof 的只读/受控查询 | 修改测试结论或绕过项目授权 |
| `server/routes/run-stream.routes.ts` | 将已持久化的 Run、Graph、Recovery、Proof 事件投递到 SSE | 把 SSE 当作业务事实或修改 Machine Gate |
| `server/routes/run-repair-session.routes.ts` | 中断恢复、Repair sandbox 会话、验证、导出与显式 apply | 直接修改原项目；apply 仍经 Write Safety 层和确认流程 |
| `server/routes/workbench-operations.routes.ts` | 连接器、Intake、Planning、Benchmark、提交检查与需求验收入口 | 充当长期业务状态的权威来源 |
| `server/services/projectRuntime.service.ts` | 项目运行时的启动、状态恢复和进程生命周期 | Run 最终状态或前端 UI 状态 |
| `server/services/runAccess.service.ts` | Run 到项目/组织的访问约束 | 业务裁决或 Evidence 生成 |

所有 Route 都只解析输入、执行授权并调用领域模块；Route 不得把 LLM 建议写成通过结论。

## Runner 与证据链

| 模块 | 唯一责任 | 不变量 |
| --- | --- | --- |
| `testRunner.ts` | 组合运行时、尝试生命周期与兼容导出 | 不直接生成最终通过结论 |
| `runner/scenarioExecution.ts` | 在预算、编译计划和 capability 约束下执行浏览器动作 | 失败路径持久化证据后继续独立路径；不执行任意模型字符串 |
| `runner/runFinalization.ts` | 汇总 Artifact/Evidence、Judge 输入、Proof Graph、报告与 Bundle | Machine Gate 始终先于 LLM 建议；Proof 不一致只能降级 |
| `runner/machineGateFinalization.ts` | 重算 Gate 输入并生成不可被 Judge 覆盖的最终机器裁决 | Gate fail/blocked 不能变为 pass |
| `runner/compiledPlanBinding.ts` | 验证已编译的 DSL 与场景绑定并执行允许动作 | 未绑定计划不可执行 |

## Graph 与状态

`packages/agent-orchestration/src/state.ts` 为阶段状态建立窄类型；`graphNodes.ts` 和 `subgraphs.ts` 划分 Discovery、Planning、Runtime Recovery、Browser、Non-browser、Evidence/Gate、Triage、Repair 与 Finalization 的职责。九个边界均为实际编译的窄状态子图：父图只传递各自声明的输入字段，并只接收其声明输出。Recovery、Browser、Non-browser 与 Repair 作为原生嵌套子图继承父图 checkpoint，因此凭据、浏览器授权、Worker 结果或修复决策恢复时不会重放副作用；Planning 审批中断仍由父图持有。详细状态契约见 [typed-subgraphs.md](./typed-subgraphs.md)。

P0-3 的代码级子图迁移已完成；外部项目盲测、干净 Linux 复验等独立 P0 验收仍须按其报告单独判定。

## 前端状态

后端 Durable Run、Evidence、Gate 和 Graph Projection 是业务权威来源。Workbench 本地状态只可保存面板展开、筛选、短暂输入和请求中的 UI 状态。

| 模块 | 唯一责任 | 不变量 |
| --- | --- | --- |
| `components/PlanningConversationPanel.tsx` | 测试目标输入、规划草案和明确确认动作的展示 | 不保存或伪造 Graph Run；确认、授权和凭据绑定均回调至后端流程 |
| `components/AssistantPlanningSidebar.tsx` | 左侧助手消息流、待决中断、功能摘要与测试计划确认入口的展示 | 不持有 Graph 或业务状态；所有修复、授权、凭据和确认动作均委托给 API-backed 回调 |
| `components/ContextSupplementPanel.tsx` | 可选 diff、缺陷单、PR/远程资料及其 Intake 解释 | 输入资料是非可信上下文，不能直接成为 Gate Evidence |
| `components/LiveWorkspacePanel.tsx` | 沙盒浏览器现场和只在修复会话中可见的代码面板 | 页面交互经 run-scoped Browser Session；代码写入仍只到 Repair sandbox |
| `components/ExecutionTimelinePanel.tsx` | 运行对话、轨迹和报告三种投影视图 | 只读取持久化 Run/Trace 投影，不从前端生成结论 |
| `hooks/useSharedBrowserInteractions.ts` | 用户接管、点击、键盘和输入的受控会话调用 | 每个操作携带当前 Run，会话关闭后拒绝操作，控制权由服务端授予 |
| `hooks/useRepairWorkspaceActions.ts` | Repair sandbox 的创建、验证、导出和显式 apply 调用 | 原项目不在浏览器端写入；验证成功仅更新对应 Child Run 的展示投影 |
| `hooks/useProjectSelection.ts` | 跨项目切换时的旧 Run/计划清理与元数据重载 | 旧项目投影在新项目加载前失效；异步识别完成后才解除对应项目的加载态 |
| `hooks/useAdvancedOperations.ts` | 巡检、通知、Harness gap 草案与状态更新 | 浏览器巡检先经过 capability 授权；推送与草案结果来自后端持久化响应 |
| `hooks/usePlanningFlowEdits.ts` | 规划草案的排除、改名、手工补充与重置 | 仅修改尚未确认的草案；已启动 Run 保留不可变的已编译计划 |
| `hooks/usePlanningConversationRequest.ts` | 将用户消息编译为规划请求，发布扫描/规划草案及其消息投影 | 只生成可确认草案；不启动沙盒、不执行测试，也不生成 Gate 结论 |
| `hooks/useConfirmedScenarioExecution.ts` | 已确认计划的创建 Run、审批、等待报告与投影更新 | 仅调用显式 Run API；不重新规划、不改变 Machine Gate，也不写目标项目 |
| `hooks/useProjectPreparation.ts` | 保存项目配置、等待受控沙盒启动，并发布连接就绪状态 | 不生成测试计划或 Run；启动失败保持可诊断状态，不伪造页面可访问 |
| `hooks/useAutomaticPlanning.ts` | 已确认规划后的项目准备、真实页面发现、路径绑定与父 Run 调度 | 未授权、登录墙、未绑定路径和执行失败均保持明确 blocked/诊断，不生成伪通过 |
| `hooks/useProjectRecovery.ts` | 沙盒/Discovery 恢复请求与持久化恢复投影轮询 | 恢复失败保持 blocked，不创建无证据 pass，也不写原项目源码 |
| `hooks/useProjectRuntimeOperations.ts` | 项目识别、启动诊断、恢复建议与加密测试账号保存 | 新诊断会清除过期 Run 投影；环境失败只发布 blocked/诊断，凭据保存不创建重复 Run |
| `hooks/useContextRefresh.ts` | Workbench 项目、审计和测试资产的只读刷新 | Agent 暂断时只回退本机项目历史；次级审计数据按需读取，不改变 Run/计划结论 |
| `hooks/useWorkbenchLifecycleEffects.ts` | OIDC 连接、Run/浏览器/证据投影、SSE 与缓存恢复 | 持久化 Run、Graph Projection 和 Browser Session 是权威；短暂 SSE 空响应不清除已有现场 |
| `hooks/useAutomaticDiagnosticExplanation.ts` | 对一个持久化阻塞结论生成一次证据约束的助手解释 | 模型不可用不清除机器结论或证据；同一结论不重复生成解释 |
| `hooks/useRunInspectionActions.ts` | 历史 Run Bundle/Projection 打开与 Retention dry-run | 结果只来自后端 Bundle 和 Projection；保留演练不应用删除操作 |

`workbench-ui/src/App.tsx` 已由 6,486 行降至 3,172 行，低于 P0-2 的减半目标（3,243 行）；`server.ts`、`testRunner.ts` 与 `agentGraphService.ts` 分别为 1,544、1,181 与 1,264 行，同样低于各自基线的一半。Run control 路由已继续迁移到独立模块。P0-2 的行数门槛已满足。`App.tsx` 仍负责页面组合和跨流程请求状态，后续可继续迁移，但这不影响该门槛的结论。四个基线行数和 50% 上限已登记在 `scripts/god-file-baselines.json`，由 `npm run size-guard` 独立校验，而不是只依赖本文的手工记录。

## 文件大小门禁

`npm run size-guard` 的默认上限为 2,000 行。四个 P0-2 God File 另有不可回退的 50% 基线门禁；新增业务源码（包括尚未加入 Git 的文件）超过 800 行也会失败。`App.tsx` 的高于通用阈值豁免只保留到其 3,243 行上限，拆分完成后必须删除。
