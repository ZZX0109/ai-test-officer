# 可持续 Agent 模块

本版本把模型调用、历史经验和写操作安全边界接入原有 LangGraph/Playwright 主链，模块入口集中在 `agent/src/agentSustainability.ts`。

| 模块 | 作用 | 接入位置 |
| --- | --- | --- |
| ContextLayer | 按项目/Run/证据命名空间读取并脱敏上下文，过期策略 fail-closed | Planner 上下文、Tool Gateway |
| MemoryService | 项目记忆和失败修复经验，支持有界语义检索 | Planner、反馈闭环 |
| ToolGateway | LLM 只能调用注册的只读工具；写工具不直接执行 | Agent 辅助查询 |
| WriteSafetyLayer | Action 风险评估、策略校验、审批工作流和执行日志 | 沙盒修复/未来写操作 |
| Tracer | `trace_id → span_id` 追踪规划、工具、执行、证据和裁决 | LLM Planner、Graph triage |
| LlmInputCompiler | 将事实、观测证据、检索知识和未知项压缩为版本化输入 | LLM Planner |
| FeedbackLoop | 失败 → RCA → 修复提案 → 验证 → Experience Memory | Graph `triage-failure` |

## 运行时检查

Agent 启动后可通过受保护接口读取模块状态：

```text
GET /api/agent/sustainability
GET /api/agent/tools
GET /api/runs/:runId/trace
```

响应只包含结构化元数据、脱敏摘要和工具版本，不返回 API Key、Authorization header、完整 Prompt 或原始密钥文件。

## 边界

- LLM 输入只能使用可追溯的事实和观测；未知项会保留为未知，不会被模型猜测成执行权限。
- Tool Gateway 默认只注册只读工具。写入、源码应用、联网安装和危险命令仍需现有权限系统与人工确认。
- Tracer、Memory 和反馈会话当前使用进程内适配器，正式部署可替换为 PostgreSQL 适配器；它们不改变 PostgreSQL Run Event、Artifact v2 和确定性 Gate 的事实源地位。
- 任何模块异常都不能把机器 `fail`/`blocked` 升级为 `pass`。
