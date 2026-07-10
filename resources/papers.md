# 核心研究论文记录

更新时间：2026-07-03  
适用项目：AI 测试官 / 提交前显式灰度验收 Agent

## 阅读优先级

建议先读：

1. ReAct
2. SWE-bench
3. SWE-agent
4. Agentless
5. CoverUp
6. TestGen-LLM
7. WebTestPilot

如果时间充裕，再读 Reflexion、Self-Refine、ExecutionAgent、OpenHands 和 LLM 测试分类研究。

## 本项目核心研究痛点映射

1. 真实变更理解不是只读 diff：SWE-bench 提醒真实 issue/PR 需要跨文件、跨上下文、执行验证；本项目必须把 Git/PR、需求、Bug 单、历史报告和执行证据放进同一个 context。
2. Agent 的界面会影响能力上限：SWE-agent 证明 Agent-Computer Interface 很关键；本项目的核心不是聊天框，而是可审计的测试工作台、权限门禁和证据面板。
3. 复杂 Agent 不一定更可靠：Agentless 提醒要优先构建简单、可解释、可验证的流程；本项目先做单 Agent 固定 loop，而不是多 Agent 自治编排。
4. E2E 测试最难的是 oracle：WebTestPilot 和 LLM 测试分类研究都指向 oracle 难题；本项目必须把自然语言需求转成 DOM/network/screenshot 可验证断言，并标注断言来源。
5. 覆盖反馈要服务风险判断：CoverUp 与 TestGen-LLM 说明测试生成需要执行和覆盖反馈；本项目优先做风险覆盖矩阵，再扩展代码覆盖率。
6. 执行环境本身是 harness 的一部分：ExecutionAgent 指出任意项目测试执行受依赖、端口、脚本和环境变量影响；本项目需要环境检查、运行包和可复现报告。
7. Loop 要可视化、可回放、可修正：ReAct、Reflexion、Self-Refine 共同支撑 `plan -> act -> observe -> judge -> retry/refine` 的显式循环；本项目用 Loop Trace 展示每一步理由、动作、观察和裁决。

## 1. ReAct: Synergizing Reasoning and Acting in Language Models

链接：https://arxiv.org/abs/2210.03629

研究重点：

- 将 reasoning 和 action 交替组织。
- Agent 不只是一次性输出答案，而是在行动后观察环境，再继续决策。

对本项目的启发：

- AI 测试官应显式展示 `reason -> action -> observe -> decision`。
- 适合支撑 Loop Trace：计划、点击、观察、断言、重试、报告。

落地模块：

- `visual_gray_runner`
- `loopEventStore`
- `Loop Trace` UI

## 2. Reflexion: Language Agents with Verbal Reinforcement Learning

链接：https://arxiv.org/abs/2303.11366

研究重点：

- Agent 将失败反馈转成自然语言反思。
- 后续任务可复用这些反思，不必训练模型。

对本项目的启发：

- 每次测试失败后生成 `reflection_note`。
- 例如“筛选失败优先检查 network query，而不是只看页面文本”。

落地模块：

- `failure_classifier`
- `run_history`
- `harness_improvement_loop`

## 3. Self-Refine: Iterative Refinement with Self-Feedback

链接：https://arxiv.org/abs/2303.17651

研究重点：

- 生成、反馈、修正三步循环。
- 适合不训练模型的迭代改进场景。

对本项目的启发：

- 初版测试 plan 不应直接执行到底。
- 应支持用户或执行器反馈后修正 plan。

落地模块：

- `gray_plan_generator`
- `Plan Refinement Loop`
- `human_review_gate`

## 4. SWE-bench: Can Language Models Resolve Real-World GitHub Issues?

链接：https://arxiv.org/abs/2310.06770

研究重点：

- 用真实 GitHub issue 检验模型软件工程能力。
- 真实任务需要跨文件上下文、执行测试、理解仓库结构。

对本项目的启发：

- Git diff 只是入口，不是完整上下文。
- 测试官需要结合需求、PR、历史测试、接口契约和执行结果。

落地模块：

- `context_collector`
- `diff_analyzer`
- `impact_mapper`
- `evidence_refs`

## 5. SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering

链接：https://arxiv.org/abs/2405.15793

研究重点：

- Agent 的计算机接口会显著影响表现。
- 软件工程 Agent 需要专门设计的工具和环境。

对本项目的启发：

- AI 测试官的接口不是普通聊天框，而是测试工作台。
- 工具调用应结构化、可审计、可复核。

落地模块：

- `permission_gate`
- `browser_controller`
- `screen_capture`
- `evidence_store`
- `workbench-ui`

## 6. Agentless: Demystifying LLM-based Software Engineering Agents

链接：https://arxiv.org/abs/2407.01489

研究重点：

- 复杂 Agent 并不总是必要。
- 简单、可解释、可验证的流程可能更稳定。

对本项目的启发：

- MVP 不应先做多 Agent。
- 先把单 Agent 的 harness 和 loop 做稳。

落地模块：

- 固定灰度层级
- 固定 loop state machine
- 可视化证据链

## 7. CoverUp: Coverage-Guided LLM-Based Test Generation

链接：https://arxiv.org/abs/2403.16218

研究重点：

- 用覆盖率反馈引导 LLM 生成测试。
- 生成测试需要执行反馈，而不是一次性猜测。

对本项目的启发：

- 本项目第一阶段应做“风险覆盖矩阵”，而不是只追代码覆盖率。
- 风险点必须能映射到测试路径和证据。

落地模块：

- `risk_coverage_matrix`
- `coverage_collector`
- `report_generator`

## 8. Automated Unit Test Improvement using Large Language Models at Meta / TestGen-LLM

链接：https://arxiv.org/abs/2402.09171

研究重点：

- LLM 生成测试不能直接采纳。
- 工业场景需要构建、稳定性、覆盖提升等过滤器。

对本项目的启发：

- LLM 生成的测试 plan 必须经过过滤和人工确认。
- `llm_inferred` 断言不能直接作为阻塞发布依据。

落地模块：

- `test_plan_filter`
- `oracle_builder`
- `human_review_gate`

## 9. You Name It, I Run It: An LLM Agent to Execute Tests of Arbitrary Projects

链接：https://arxiv.org/abs/2412.10133

研究重点：

- 自动运行任意项目测试很难。
- 难点来自依赖、命令、环境变量、端口、数据库和框架差异。

对本项目的启发：

- 测试执行环境本身是 harness 的核心。
- 第一版应固定 Demo 应用和工具链，不要承诺任意项目适配。

落地模块：

- `environment_profile`
- `environment_checker`
- `test_command_runner`

## 10. WebTestPilot: Agentic End-to-End Web Testing against Natural Language Specification by Inferring Oracles with Symbolized GUI Elements

链接：https://arxiv.org/abs/2602.11724

研究重点：

- Web E2E 测试关键在 oracle。
- 自然语言需求需要转成 GUI 状态、前置条件和后置条件。

对本项目的启发：

- 点击页面不是核心，判断页面是否符合需求才是核心。
- 需要把需求变成可验证 oracle。

落地模块：

- `oracle_builder`
- DOM/network/screenshot 联合断言
- `evidence_conflict_loop`

## 11. Challenges in Testing Large Language Model Based Software: A Faceted Taxonomy

链接：https://arxiv.org/abs/2503.00481

研究重点：

- LLM 软件测试具有非确定性、oracle 难、评估难等问题。
- 单次 pass/fail 不足以说明系统稳定。

对本项目的启发：

- 报告要记录模型、prompt、参数、执行次数和聚合结论。
- 关键路径可重复执行，输出 aggregated verdict。

落地模块：

- `run_history`
- `repeat_runner`
- `aggregated_verdict`

## 12. OpenHands: An Open Platform for AI Software Developers as Generalist Agents

链接：https://arxiv.org/abs/2407.16741

研究重点：

- 通用软件工程 Agent 平台需要安全环境、工具调用、评估体系和可扩展架构。

对本项目的启发：

- AI 测试官应作为小型测试 Agent 平台构建，而不是单页 Demo。
- 每次测试应生成可复现 run bundle。

落地模块：

- `agent/`
- `workbench-ui/`
- `reports/`
- `run_bundle`

## 13. 推荐引用角度

答辩时可以这样串联：

```text
ReAct / Reflexion / Self-Refine 支撑测试循环设计；
SWE-bench / SWE-agent / Agentless / OpenHands 支撑真实软件工程 Agent 的 harness 设计；
CoverUp / TestGen-LLM / ExecutionAgent / WebTestPilot 支撑测试生成、执行、oracle 和证据链设计。
```

最终结论：

> 本项目不是单纯让 LLM 生成测试，而是基于 Harness Engineering 和 Loop Engineering，把测试上下文、工具、权限、oracle、执行证据、失败恢复和人类裁决组织成一个可视化质量验收系统。
