# Evidence-Grounded Testing：AI 测试结论的可审计门禁

## 核心命题

通用 LLM 测试 Agent 的主要风险不是“不能生成步骤”，而是会把不可信的需求、网页文本或单次表面现象误当成放行依据。AI 测试官采用三层决策：确定性机器门禁负责断言、Artifact 完整性与执行环境；LLM 仅负责计划、归因与解释；人工只处理冲突、未知场景和授权边界。任何一层的证据不足都不能升级为普通 `pass`。

## 可审计机制

1. 每个 Artifact v2 绑定 `runId`、`scenarioId`、`stepId`、`attemptId`、单调时钟、SHA-256 和采集器版本。
2. 每个通过断言生成 Evidence Quality 记录：所需 Artifact 类别、同 attempt 的运行时 Artifact、evidence ID、来源和缺失原因。
3. 通过断言缺少所需 DOM、Network、Console 或 Screenshot 证据时，机器 Gate 至少输出 `needs-human-review`，不能输出普通 `pass`。
4. simulated、legacy、user-uploaded Artifact 不可作为正式 Gate 的核心运行时输出；fixture 只能证明前置输入。
5. requirement、Diff、DOM、console、network 和 Artifact payload 均视为不可信数据。发现指令注入、凭据外泄或危险命令信号时，Judge 进入人工复核，并引用触发信号的 evidence ID。

## 可证伪实验设计

冻结后对每个案例运行五条独立通道：测试命令 baseline、规则计划+规则 Judge、LLM 计划+规则 Judge、规则计划+LLM Judge、完整 LLM。两种固定模型各重复三次。Evaluator 独占人工标签，运行容器不可读取。

盲测必须同时满足：False Release 为零、Artifact 完整率和 grounded evidence rate 为 100%、证据引用准确率为 100%、一致性至少 85%、模型失败率低于 5%，且完整 LLM 相比规则通道的 Macro-F1 增益至少 0.08 或任务成功率提高至少 10 个百分点；人工复核率还必须下降至少 20%。否则结论固定为“尚未证明 LLM 增益”。

## 当前证据边界

本仓库已验证确定性 Gate、Artifact v2、对抗输入拒绝、影响分析主链和真实浏览器测试。模型凭据和 Docker daemon 未配置时，Benchmark 和生产验收会明确返回 `blocked`；不得将规则校准集结果解释为 LLM 效果。
