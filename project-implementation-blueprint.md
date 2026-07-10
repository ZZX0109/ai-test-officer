# AI代码质检系统：项目计划与资料清单（v1）

版本时间：2026-06
项目定位：提交前代码变更质检 Agent，输入 diff/PR，输出可追溯风险报告与建议。

> 最新对齐说明（2026-07-02）：本蓝图是 v1 工程计划，已经覆盖 diff/PR 质检、风险分析、测试执行和报告闭环。但后续讨论已将项目进一步收束为“显式灰度验收 Agent”：Agent 需要接管鼠标键盘进行可视化分层测试，必须捕捉电脑/窗口画面，采用类似 Codex / Claude Code 的权限分级，并由用户保留最终裁决权。详细差距见 `docs/blueprint-gap-analysis.md`，前沿研究和产品原则见 `docs/frontier-research-pain-points.md`。

## 一、项目计划

### 1. 目标（最小可交付）
做一个“可演示闭环”：
1. 读取一段代码变更（git diff / PR 文本）。
2. 解析变更意图，生成结构化风险清单（函数/文件/接口/边界场景）。
3. 生成分层测试策略：冒烟、关键路径、异常边界、回归。
4. 自动执行测试并采集：通过率、失败用例、日志、trace、截图/请求失败信息（若有 Web 路径）。
5. 用 LLM Judge 生成结构化报告：真实问题 vs 误报、覆盖缺口、风险评分、是否可发布建议。

### 2. 里程碑建议（14~20 天版本）

#### Phase 0：范围固定（Day 1）
- 明确目标语言栈（建议先锁定 `Python + FastAPI` 或 `TypeScript + Express` 二选一）
- 锁定示例项目（一个小型 web/app）
- 锁定测试工具链：`pytest` 或 `vitest` + `playwright`（若涉及前端 E2E）
- 输出文档：`architecture.md`、`risk-matrix.md`

#### Phase 1：输入与建模（Day 2~4）
- 实现 diff 解析器
  - 输入：unified diff / PR body / issue 链接
  - 输出：改动文件、改动函数、关键变量、疑似受影响模块
- 实现静态信号层
  - 代码片段摘要
  - 粗粒度影响范围（路由、服务、数据库、前端组件）
  - 简单危险规则（空指针、空输入、异常返回未处理、超时配置修改）
- 输出结构化 JSON + 可读自然语言摘要

#### Phase 2：测试策略生成（Day 5~7）
- 设计 prompt schema，固定输出格式（JSON schema）
  - `test_plan`（优先级 + 场景 + 前置条件 + 预期）
  - `risk_map`（高、中、低风险）
  - `coverage_plan`（必测 vs 可延后）
- 第一个版本先生成“本地可执行测试骨架”
- 自动过滤不执行项（耗时过高/有副作用）

#### Phase 3：执行引擎（Day 8~11）
- 集成测试运行器：
  - 单元测试执行
  - API/集成测试执行
  - 可选 Playwright 冒烟脚本（页面路径）
- 统一结果抽象（统一结构）：
  - `passed` / `failed` / `skipped`
  - `stderr/stdout`
  - `exit_code`
  - `artifacts`（截图、trace、日志）
- 加入幂等执行与错误归类
  - 环境问题、测试脚本问题、逻辑回归问题

#### Phase 4：执行反馈与报告（Day 12~14）
- 加入 `result judge` 模块
  - 失败用例归因（代码回归 / 环境抖动 / 用例设计缺陷）
  - 覆盖缺口识别（受影响功能但未覆盖）
  - 风险评分（0~100）
  - 建议动作（阻塞发布 / 先修复 / 观察）
- 输出报告模板：
  - 一页摘要（适合 CI）
  - 详细页（用于开发者 review）

#### Phase 5：展示 Demo（Day 15~18）
- 准备两类演示输入：
  1. 正常需求改动（功能增强）
  2. 有意引入 bug 的改动（测试触发）
- 做两段演示视频：
  - 自动生成测试 -> 执行 -> 解释 -> 报告
  - 误报复核（模型错误时如何人工 override）
- 加分项：接一个 PR webhook，自动触发一次质检（本地 mock 也可以）

### 3. 验收标准（你在答辩可讲）
- 演示路径稳定可复现，至少 1 套 diff 输入能跑完闭环
- 报告中必须出现：
  - 受影响模块列表
  - 风险等级
  - 失败归因（至少 1 条）
  - 覆盖建议
- 同一输入，结果可重复且可追溯（保留 artifacts + 时间戳）

## 二、你需要具备的预备知识

### A. 代码与工程基础（必须）
- Git：分支、diff、merge、rebase、stash、冲突处理
- Python/TypeScript 基础（取决于你的技术栈）
- 项目调试与日志读取能力（stack trace、错误码、超时、依赖问题）
- Docker 或沙箱环境使用（至少知道如何跑隔离测试）

### B. 软件测试基础（必须）
- 测试金字塔（单测、集成、E2E）
- 测试分类：冒烟、回归、边界、异常、幂等、兼容
- 变更影响分析（Change Impact Analysis）
- 失败归因：Bug / flaky test / 环境噪音 / 测试不准确

### C. 数据与后端系统（必须）
- JSON Schema 与可验证输出
- 队列与任务调度（至少能做串行/并发执行控制）
- 文件/数据库建模（sqlite/postgres 都可）
- 缓存与限流（防止 webhook 瞎跑）

### D. LLM/Agent 工程（重点）
- Prompt 工程（schema 约束、函数调用、反事实约束）
- Tool Use（命令执行、文件读写、测试命令注入）
- 人工反馈闭环（Execution-grounded refinement，重试与降级）
- Agent 架构（Planner/Executor/Judge）

### E. 线上工程化（加分）
- CI/CD 基础（GitHub Actions）
- 安全边界：禁止危险命令、只读目录、时间/资源预算
- 可观测性：日志格式、指标、告警、可视化

## 三、建议阅读论文（核心+选读）

> 先看 5-8 篇，别贪多。核心优先理解“结构化输出 + 执行反馈 + 反馈式改进”。

### 核心论文（建议先读）

1. ReAct: Synergizing Reasoning and Acting in Language Models  
   https://arxiv.org/abs/2210.03629  
   说明了 Reasoning 与 Action 的交替，适合你用在 Planner/Executor 的控制思想。

2. SWE-bench: Can Language Models Resolve Real-World GitHub Issues?  
   https://arxiv.org/abs/2310.06770  
   你这个项目的评价背景，知道为什么要“基于现实仓库、基于执行结果”。

3. SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering  
   https://arxiv.org/abs/2405.15793  
   给了“agent 与代码环境交互”怎么设计的实证。

4. Self-Refine: Iterative Refinement with Self-Feedback  
   https://arxiv.org/abs/2303.17651  
   给了“失败后再迭代”的提示范式，不需要训模型也能做规则化改进。

5. Reflexion: Language Agents with Verbal Reinforcement Learning  
   https://arxiv.org/abs/2303.11366  
   参考“如何让 agent 从反馈中学习决策偏差”。

6. OpenHands: An Open Platform for AI Software Developers as Generalist Agents  
   https://arxiv.org/abs/2407.16741  
   参考“通用开发 agent 架构 + 工具化执行 + 统一事件流”。

### LLM 测试生成与执行增强（选读）

7. CoverUp: Coverage-Guided LLM-Based Test Generation  
   https://arxiv.org/abs/2403.16218  
   你要做测试生成时的方向：覆盖率反馈驱动的闭环。

8. AutoCodeRover: Autonomous Program Improvement  
   https://arxiv.org/abs/2404.05427  
   了解“代码搜索+自动修复+验证”思路与现实局限。

9. Agentless: Demystifying LLM-based Software Engineering Agents  
   https://arxiv.org/abs/2407.01489  
   对比了不同 agent 思路的边界，也能帮助你定义演示指标（不盲目追求最高分）。

10. Training Software Engineering Agents and Verifiers with SWE-Gym  
    https://arxiv.org/abs/2412.21139  
    适合你项目后续延展，不是必须，但很值得看。

## 四、类似 GitHub 项目（可借鉴）

### 可以直接“抄思路 + 对比”

1. SWE-bench（基准任务与评估框架）  
   https://github.com/swe-bench/SWE-bench  

2. SWE-agent（自动修复 GitHub issue / ACI 设计）  
   https://github.com/swe-agent/swe-agent  

3. OpenHands（通用 agent 平台）  
   https://github.com/OpenHands/OpenHands  

4. AutoCodeRover（AST/程序改进路径）  
   https://github.com/AutoCodeRoverSG/auto-code-rover  

5. SWE-Gym（软件工程任务环境）  
   https://github.com/SWE-Gym/SWE-Gym  

6. SWE-bench experiments（预测日志、轨迹、复现实验）  
   https://github.com/SWE-bench/experiments  

7. GitTaskBench（真实仓库任务评估）  
   https://github.com/QuantaAlpha/GitTaskBench  

8. Agentless（实现反思：简化路径 + 低成本执行）  
   https://github.com/OpenAutoCoder/Agentless  

### 可用于“工程化底座”

9. AutoGen（多智能体与工具协作）  
   https://github.com/microsoft/autogen  

10. Aider（命令行 AI pair-programming，CLI 与测试工作流思路）  
    https://github.com/Aider-AI/aider  

## 五、文件组织建议（你放入项目即可）

创建参考资源文件夹，方便比赛评审看你做了“研究+工程”两条线：

```text
project-02-ai-test-officer/
  project-implementation-blueprint.md
  docs/
    architecture.md
    demo-script.md
  resources/
    papers.md
    similar-projects.md
  data/
    sample-diffs/
  experiments/
    run-logs/
  reports/
    templates/
```

建议你把这篇文件作为项目总说明，`resources/papers.md` 和 `resources/similar-projects.md` 可以从上面直接拆过去做两个专门索引。
