# 基于 Harness Engineering 与 Loop Engineering 的开发计划

更新时间：2026-07-02  
适用项目：AI 测试官 / 提交前显式灰度验收 Agent  
当前代码基线：已具备 `agent/`、`app-under-test/`、`workbench-ui/`、Credential Center、固定灰度 plan、Playwright 执行、截图证据、权限确认与审计日志。

## 1. 计划结论

本项目下一阶段不应继续堆“AI 功能”，而应把系统明确拆成两层：

```text
Harness Engineering：把 Agent 放进可靠、受控、可审计的测试环境。
Loop Engineering：把 Agent 的计划、执行、观察、重试、复核、裁决过程显式建模。
```

产品目标：

> 做一个可视化测试循环工作台。用户不仅能看到 Agent 跑了什么测试，还能看到它为什么进入下一步、为什么重试、为什么停止、哪些证据支撑结论、哪些结论需要人裁决。

这会把项目从“AI 自动测试工具”升级为“AI 测试过程控制系统”。

## 1.1 当前落地状态

实现状态：MVP 已落地  
完成日期：2026-07-02

已落地代码：

| 计划项 | 当前实现 |
|---|---|
| Harness 正规化 | `agent/src/evidenceStore.ts`、`agent/src/oracleBuilder.ts`、`agent/src/riskCoverage.ts`、`run_bundle.json` |
| Loop Trace MVP | `agent/src/loopEventStore.ts`、`GET /api/loop-events/latest`、工作台 `Loop Trace` 面板 |
| Oracle Builder | `agent/src/oracleBuilder.ts`，已覆盖任务筛选页面加载、请求参数、DOM 状态三类 oracle |
| Evidence Conflict Replay | `agent/src/conflictReplay.ts`，当前将失败重试后的证据打包为 `conflictPacket` 提交用户复核 |
| Risk Coverage Matrix | `agent/src/riskCoverage.ts`，报告输出风险覆盖、通过状态、证据引用 |
| LLM Plan Refinement | `agent/src/planRefinement.ts`、`POST /api/refine-plan`，只返回 proposal，不直接修改执行结果 |
| Run History 与 Aggregated Verdict | `agent/src/runHistory.ts`、`GET /api/run-history`，报告输出聚合结论和 flaky 标记 |
| Desktop Capture Adapter | `agent/src/desktopCaptureAdapter.ts`、`GET /api/desktop-capture/status`、`POST /api/desktop-capture/screenshot`，默认手动触发 |
| Environment Check | `agent/src/environmentCheck.ts`、`POST /api/environment-check` |

已验证：

- `npm run typecheck` 通过。
- `npm run build` 通过。
- `npm audit --omit=dev` 通过。
- 一次显式灰度运行能产出 evidence、loop events、oracle、risk coverage、aggregated verdict、conflict packet 和 run bundle。

当前限制：

- Desktop Capture Adapter 只做 macOS 手动截图入口，默认不自动捕捉桌面，避免隐私风险。
- Evidence Conflict Replay 当前是“失败重试 + 复核包”形态，还不是完整的双运行视觉 diff。
- LLM Plan Refinement 当前是 proposal 生成，尚未接 UI 中的确认/应用流程。

## 2. 前沿论文依据

### 2.1 ReAct：推理与行动交替

论文：ReAct: Synergizing Reasoning and Acting in Language Models  
链接：https://arxiv.org/abs/2210.03629

核心启发：

- Agent 不应只一次性生成答案，而应在“reason -> act -> observe”之间循环。
- 对本项目而言，测试官应把每一步操作和观察都记录下来。

落地：

- `Plan Loop`：读 diff/需求，生成风险和测试路径。
- `Execution Loop`：执行动作，观察 DOM/network/screenshot。
- `Decision Loop`：根据观察决定通过、重试、继续、停止或交给人。

### 2.2 Reflexion：失败后形成可复用反思

论文：Reflexion: Language Agents with Verbal Reinforcement Learning  
链接：https://arxiv.org/abs/2303.11366

核心启发：

- Agent 可以把失败反馈转成语言化经验，供下一轮使用。
- 不需要训练模型，也能通过反思记忆改善下一次行为。

落地：

- 每次失败后生成 `reflection_note`。
- 例如“已完成筛选失败常见原因：请求未携带 status 参数；下一次优先检查 network”。
- 将 `reflection_note` 写入 run report 和后续 plan context，但必须标注为经验，不作为唯一事实。

### 2.3 Self-Refine：生成、反馈、修正的迭代模式

论文：Self-Refine: Iterative Refinement with Self-Feedback  
链接：https://arxiv.org/abs/2303.17651

核心启发：

- LLM 首次输出通常不是最优，需要反馈和修正。
- 对测试计划尤其重要：初版 plan 需要由执行结果、覆盖缺口和用户反馈修正。

落地：

- `Plan Refinement Loop`：
  1. 生成初版测试 plan。
  2. 用户或执行器指出缺口。
  3. LLM 修正 plan。
  4. 修正前后差异进入审计日志。

### 2.4 SWE-bench：真实软件问题需要跨文件上下文和执行验证

论文：SWE-bench: Can Language Models Resolve Real-World GitHub Issues?  
链接：https://arxiv.org/abs/2310.06770

核心启发：

- 真实软件任务经常需要跨文件、跨函数、跨上下文理解。
- 单看 diff 不够，必须结合仓库结构、历史测试、接口契约和执行结果。

落地：

- Harness 中增加 `context_collector`：
  - Git diff。
  - 需求/PR 描述。
  - 相关测试。
  - API 契约。
  - 历史报告。
- 每个风险判断必须有 evidence refs。

### 2.5 SWE-agent：Agent 需要专门设计的计算机接口

论文：SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering  
链接：https://arxiv.org/abs/2405.15793

核心启发：

- Agent-Computer Interface 直接影响 Agent 的表现。
- 工具不是越多越好，而是要让 Agent 能稳定读、改、跑、观察。

落地：

- 本项目的 ACI 不是 IDE 编辑器，而是测试工作台：
  - `browser_controller`
  - `screen_capture`
  - `network_collector`
  - `console_collector`
  - `permission_gate`
  - `evidence_store`
- 所有工具调用必须产生结构化事件。

### 2.6 Agentless：复杂 Agent 不一定优于简单可解释流程

论文：Agentless: Demystifying LLM-based Software Engineering Agents  
链接：https://arxiv.org/abs/2407.01489

核心启发：

- 软件工程任务中，简单、可解释、可验证的流程可能比复杂自治 Agent 更有效。
- 本项目不应急着做多 Agent，而应先做确定的测试循环和可复核证据。

落地：

- MVP 不做多 Agent 编排。
- 先做单 Agent + 固定 loop state machine。
- LLM 只能在计划和归因环节提供建议，不能绕过权限和证据校验。

### 2.7 CoverUp：覆盖反馈驱动测试生成

论文：CoverUp: Coverage-Guided LLM-Based Test Generation  
链接：https://arxiv.org/abs/2403.16218

核心启发：

- 测试生成需要覆盖率和反馈来引导，而不是靠模型一次性猜。
- 对本项目而言，更重要的是“风险覆盖”，不只是代码覆盖。

落地：

- 增加 `risk_coverage_matrix`：
  - 风险点。
  - 覆盖它的测试路径。
  - 证据类型。
  - 是否通过。
- 后续再接代码 coverage。

### 2.8 TestGen-LLM：LLM 生成测试必须经过过滤器

论文：Automated Unit Test Improvement using Large Language Models at Meta / TestGen-LLM  
链接：https://arxiv.org/abs/2402.09171

核心启发：

- 工业场景下不能直接采纳 LLM 测试。
- 生成测试要经过构建、稳定性、覆盖提升等过滤。

落地：

- 增加 `test_plan_filter`：
  - 是否有明确 oracle。
  - 是否可执行。
  - 是否触达本次风险。
  - 是否需要人工确认。
- `llm_inferred` 预期不能直接阻塞发布。

### 2.9 ExecutionAgent：测试执行环境本身就是难题

论文：You Name It, I Run It: An LLM Agent to Execute Tests of Arbitrary Projects  
链接：https://arxiv.org/abs/2412.10133

核心启发：

- 运行测试涉及依赖、命令、端口、环境变量、框架差异。
- 本项目要把“测试执行环境”当作 harness 的核心部分。

落地：

- 增加 `environment_profile`：
  - app URL。
  - agent URL。
  - test command。
  - required ports。
  - proxy/mock rules。
  - fixture data。
- 运行前做 `environment_check`。

### 2.10 WebTestPilot：E2E 测试关键在 oracle 和 GUI 状态符号化

论文：WebTestPilot: Agentic End-to-End Web Testing against Natural Language Specification by Inferring Oracles with Symbolized GUI Elements  
链接：https://arxiv.org/abs/2602.11724

核心启发：

- Web E2E 测试难点不是点击页面，而是判断“页面是否符合需求”。
- 需要把自然语言需求转成步骤前置/后置条件。

落地：

- 增加 `oracle_builder`：
  - 前置条件：页面已加载、任务列表存在。
  - 动作：点击已完成。
  - 后置条件：请求包含 `status=completed`，页面只显示 completed。
- 画面证据和 DOM/network 证据必须共同构成 oracle。

### 2.11 LLM 软件测试分类研究：非确定性需要聚合判断

论文：Challenges in Testing Large Language Model Based Software: A Faceted Taxonomy  
链接：https://arxiv.org/abs/2503.00481

核心启发：

- LLM 系统测试不能只看单次 pass/fail。
- 需要记录模型、prompt、参数、重复执行和聚合结论。

落地：

- 增加 `run_history`：
  - model。
  - prompt hash。
  - credential provider。
  - run id。
  - repeated result。
- 关键路径允许重复执行，最终输出 aggregated verdict。

### 2.12 OpenHands：安全环境、工具、评估和多能力平台

论文：OpenHands: An Open Platform for AI Software Developers as Generalist Agents  
链接：https://arxiv.org/abs/2407.16741

核心启发：

- 实用 Agent 平台必须包含安全执行环境、工具调用、评估 benchmark 和可扩展架构。
- 本项目应先做小平台，而不是只做一个页面 Demo。

落地：

- 明确模块边界：
  - `agent/`
  - `workbench-ui/`
  - `app-under-test/`
  - `reports/`
  - `data/`
- 后续为每次测试生成可复现 run bundle。

## 3. 本项目的 Harness 设计

### 3.1 Harness 目标

Harness 负责让 Agent 在受控环境中工作，避免黑箱自治。

```text
Test Officer Harness =
  Context Layer
  Tool Layer
  Permission Layer
  Oracle Layer
  Evidence Layer
  Recovery Layer
  Evaluation Layer
```

### 3.2 Context Layer

输入：

- `requirement_text`
- `git_diff`
- `app_url`
- `project_path`
- `environment_profile`
- `history_reports`

开发任务：

- 从当前固定 diff 迁移到 `context_collector`。
- 为每个风险、断言、报告结论附加 `evidence_refs`。

### 3.3 Tool Layer

已有工具：

- Playwright 浏览器执行。
- 截图。
- network/console 采集。
- Credential Center。

待补工具：

- DOM snapshot。
- trace/video 显式链接。
- workspace test command runner。
- proxy/mock profile。
- desktop/window capture adapter。

### 3.4 Permission Layer

已有：

- `observe`
- `browser_control`
- `workspace_control`
- `ide_terminal_control`
- `system_control`
- 浏览器接管授权和审计日志。

待补：

- 按操作动态确认。
- 权限弹窗原因说明。
- 用户撤销授权。
- 每个 run 的权限快照。

### 3.5 Oracle Layer

目标：

- 每条断言必须知道预期来源。

预期来源：

- `requirement`
- `diff`
- `existing_test`
- `historical_behavior`
- `llm_inferred`

规则：

- `llm_inferred` 进入人工确认。
- 只有需求/历史测试/基线行为支撑的断言可作为强证据。

### 3.6 Evidence Layer

证据类型：

- screenshot。
- video。
- trace。
- network。
- console。
- DOM。
- assertion。
- operation log。
- permission audit。
- user verdict。

开发任务：

- 将当前 report JSON 拆成 `evidence_store`。
- 每个 evidence item 有唯一 ID。
- UI 中点击 loop 节点能定位证据。

### 3.7 Recovery Layer

已有：

- 单路径失败后重试。
- 重试失败后继续其他路径。

待补：

- 证据冲突复现。
- flaky 检测。
- 选择器自愈。
- 重试预算配置。

### 3.8 Evaluation Layer

指标：

- 风险覆盖率。
- 证据完整度。
- 失败归因准确度。
- 用户 override 率。
- 重试后稳定性。
- token/cost。
- 单次 run 耗时。

## 4. 本项目的 Loop 设计

### 4.1 总体 Loop

```text
Plan
  -> Approve
  -> Execute
  -> Observe
  -> Verify
  -> Retry / Continue / Replay / Report
  -> Human Verdict
  -> Harness Improvement
```

### 4.2 Plan Loop

职责：

- 读需求和 diff。
- 生成风险。
- 生成灰度测试 plan。
- 过滤不可信 plan。
- 等待用户确认。

停止条件：

- 用户确认 plan。
- 用户取消。
- 缺少必要上下文。

### 4.3 Gray Execution Loop

职责：

- 按 `smoke -> core_path -> edge_case -> regression` 执行。
- 每步生成 action event。
- 每步采集 evidence。
- 每条路径生成 assertion result。

停止条件：

- 全部路径完成。
- 用户暂停。
- 权限不足。
- 环境不可用。

### 4.4 Failure Recovery Loop

职责：

- 单路径失败后重试。
- 仍失败则记录候选原因。
- 不终止整轮测试。
- 继续下一路径。

停止条件：

- 重试预算耗尽。
- 用户选择停止。

### 4.5 Evidence Conflict Loop

触发：

- 截图看似失败，但 DOM/network 通过。
- DOM 通过，但 network 异常。
- 第一次失败，重试通过。

流程：

```text
detect conflict
  -> replay same path
  -> compare evidence
  -> classify conflict
  -> submit review packet
```

### 4.6 Report Loop

职责：

- 汇总风险、路径、证据、失败。
- 生成建议动作。
- 等待用户裁决。

用户裁决：

- `accept_report`
- `rerun_failed_path`
- `mark_false_positive`
- `block_merge`
- `continue_with_note`

### 4.7 Harness Improvement Loop

职责：

- 从失败报告中提取系统改进建议。
- 更新 selector、oracle、fixture、prompt、permission policy。
- 每次改进必须人工确认。

## 5. 可视化 Loop Engineering 功能设计

### 5.1 功能名称

建议命名：

- `Loop Trace`
- `Loop Studio`
- `测试循环可视化`

MVP 用 `Loop Trace`，先做只读时间线，不做复杂编辑器。

### 5.2 目标

让用户看到：

- Agent 当前在哪个 loop。
- 当前迭代次数。
- 上一步观察到了什么。
- 为什么重试。
- 为什么继续下一路径。
- 哪些证据支撑结论。
- 哪一步等待人类裁决。

### 5.3 数据结构

```ts
type LoopType =
  | "plan_loop"
  | "approval_loop"
  | "gray_execution_loop"
  | "failure_recovery_loop"
  | "evidence_conflict_loop"
  | "report_loop"
  | "human_verdict_loop"
  | "harness_improvement_loop";

type LoopEventStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "retrying"
  | "waiting_for_user"
  | "stopped";

interface LoopEvent {
  id: string;
  runId: string;
  loopType: LoopType;
  iteration: number;
  timestamp: string;
  status: LoopEventStatus;
  title: string;
  action?: string;
  observation?: string;
  decision?: string;
  decisionReason?: string;
  evidenceRefs: string[];
  permissionRef?: string;
}
```

### 5.4 UI 设计

在工作台增加第四个逻辑面板，或在右侧 `Live Evidence` 中增加 Tab：

```text
Live Evidence
  - Screenshot
  - Assertions
  - Network
  - Loop Trace
```

`Loop Trace` 展示：

```text
[passed] Plan generated
  reason: diff touches fetchTasks

[waiting_for_user] Browser control permission requested
  reason: needs to click completed filter

[running] Core path started
  path: completed_filter_path

[failed] Network assertion failed
  expected: status=completed
  actual: no status query

[retrying] Retry same path
  reason: retry_budget = 1

[passed] Continue regression path
  reason: fail_fast = false

[waiting_for_user] Report ready
  verdict: hold_for_review
```

### 5.5 MVP 开发任务

1. 后端新增 `loopEventStore.ts`。
2. 在以下位置写入 loop event：
   - plan 生成。
   - 权限确认。
   - 打开浏览器。
   - 点击按钮。
   - 断言失败。
   - 重试。
   - 继续下一路径。
   - 报告生成。
3. 新增接口：
   - `GET /api/runs/:runId/loop-events`
   - `GET /api/loop-events/latest`
4. 工作台新增 `Loop Trace` 区域。
5. 每个 loop event 能点开关联截图或 network 证据。

## 6. 分阶段开发计划

### Phase 1：Harness 正规化

目标：把现在分散的执行结果改成统一 harness 数据模型。

任务：

- 新建 `agent/src/evidenceStore.ts`。
- 新建 `agent/src/loopEventStore.ts`。
- 新建 `agent/src/oracleBuilder.ts`。
- 给每个 screenshot/network/assertion/action 生成 ID。
- 报告中使用 evidence refs。

验收：

- 一次 run 能导出完整 `run_bundle.json`。
- UI 能根据 evidence ID 定位截图和断言。

### Phase 2：Loop Trace MVP

目标：实现可视化 loop engineering 的第一版。

任务：

- 在后端写入 loop events。
- 前端新增 Loop Trace 时间线。
- 展示 plan、permission、action、assertion、retry、report。

验收：

- 用户能看到 Agent 为什么重试。
- 用户能看到失败后为什么继续下一路径。
- 用户能看到哪些节点等待用户裁决。

### Phase 3：Oracle Builder

目标：让测试断言有明确预期来源。

任务：

- 从 requirement 中抽取后置条件。
- 将 plan path 绑定 oracle。
- 标注 `requirement` / `diff` / `llm_inferred`。
- `llm_inferred` 断言进入人工确认。

验收：

- “已完成筛选”断言来源标注为 requirement。
- 没有来源的断言不能产生阻塞结论。

### Phase 4：Evidence Conflict Replay

目标：实现截图和结构化证据冲突时的复现循环。

任务：

- 定义冲突规则。
- 自动 replay 同一路径。
- 生成 conflict packet。
- UI 展示两次执行对比。

验收：

- 人工构造一次冲突后，系统进入 replay。
- replay 结果能提交用户复核。

### Phase 5：Risk Coverage Matrix

目标：把 CoverUp 的覆盖反馈思想转成风险覆盖。

任务：

- 风险点绑定测试路径。
- 测试路径绑定 evidence。
- 输出风险覆盖矩阵。

验收：

- 报告能显示每个风险是否被覆盖。
- 未覆盖风险进入后续建议。

### Phase 6：LLM Plan Refinement

目标：让 LLM 只在受控 loop 中修正 plan。

任务：

- 生成初版 plan。
- 用户/执行反馈进入 refinement prompt。
- 生成 plan diff。
- 用户确认后替换。

验收：

- LLM 不能直接修改执行结果。
- LLM 只能提交 plan change proposal。

### Phase 7：Run History 与 Aggregated Verdict

目标：处理 LLM/测试非确定性。

任务：

- 保存模型、prompt hash、provider、run id。
- 支持关键路径重复执行。
- 输出聚合结论。

验收：

- 报告显示单次结果和聚合结果。
- flaky 路径被标记为 `needs_review`。

### Phase 8：Desktop Capture Adapter

目标：从浏览器截图升级到窗口/桌面画面捕捉。

任务：

- macOS 指定窗口截图。
- 录屏权限检测。
- 敏感区域裁剪/打码。
- 与 LoopEvent 关联。

验收：

- Live View 能展示真实窗口画面。
- 截图不会采集无关敏感窗口。

## 7. 当前代码的下一步具体改造顺序

建议直接按这个顺序动手：

1. `agent/src/loopEventStore.ts`
2. `agent/src/evidenceStore.ts`
3. 改造 `testRunner.ts`，把当前 `steps/assertions/network/console` 同步写入 evidence + loop events。
4. 改造 `server.ts`，增加 loop event 查询接口。
5. 改造 `workbench-ui/src/main.tsx`，新增 Loop Trace 面板。
6. 增加 `oracleBuilder.ts`，先硬编码任务筛选需求的 oracle。
7. 报告增加 `riskCoverageMatrix`。
8. 再做 LLM plan refinement。

## 8. 不建议现在做的事

暂缓：

- 多 Agent 编排。
- 任意电脑接管。
- 真实线上灰度流量。
- 任意仓库自动适配。
- 复杂图形化 loop 编辑器。

原因：

- 当前最重要的是让单 Agent 的 harness 和 loop 可观察、可验证。
- 多 Agent 会增加复杂度，但不会立刻增强 Demo 说服力。
- 复杂自治会增加 OpenClaw 式安全风险。

## 9. 答辩表述

推荐表达：

> 我们没有把 AI 测试官做成一个简单的“生成测试”功能，而是采用 Harness Engineering 和 Loop Engineering 来设计系统。Harness 层负责上下文、工具、权限、oracle、证据和审计，让 Agent 在受控环境中执行测试；Loop 层负责计划、执行、观察、重试、复现、报告和人类裁决。用户不仅能看到测试结果，还能看到 Agent 的测试循环如何推进、为什么重试、为什么停止、哪些证据支撑结论。这使得 AI 测试从黑箱自动化变成可视化、可追责、可复核的质量验收过程。
