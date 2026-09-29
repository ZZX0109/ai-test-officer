# 可持续 Agent 模块

本版本把模型调用、历史经验和写操作安全边界接入原有 LangGraph/Playwright 主链，模块入口集中在 `agent/src/agentSustainability.ts`。

| 模块 | 作用 | 接入位置 |
| --- | --- | --- |
| ContextLayer | 按项目/Run/证据命名空间读取并脱敏上下文，过期策略 fail-closed；超预算按优先级裁剪 | Planner、Browser Agent、Judge、Assistant、Tool Gateway |
| MemoryService | 项目记忆和失败修复经验；配置 embedding provider 时使用向量+关键词混合检索，未配置时明确降级为关键词检索 | Planner、反馈闭环 |
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
- Experience Memory 不再生成哈希伪向量。通过 `MEMORY_EMBEDDING_URL`、`MEMORY_EMBEDDING_API_KEY`、`MEMORY_EMBEDDING_MODEL` 配置 OpenAI-compatible embedding provider 后，记录和查询使用真实向量与关键词混合排序；provider 不可用时显式降级为 `keyword-v1`，不会冒充语义检索。
- `agent/src/memory/memoryRetrievalEval.ts` 提供离线 `Recall@5`、`Recall@10`、MRR、Top-10 false-recall 和 source-traceability 指标；真实 embedding provider 接入后必须用同一评测接口跑 sealed 集合。
- `data/memory/retrieval-eval-v1.json` 固定了 50 条查询、10 组同义表达、跨项目表达和无关干扰项；`npm run memory:eval:dataset` 只验证标签集完整性，并明确输出 `providerRun: required`，不会把标签集当成语义检索结果。
- 任何模块异常都不能把机器 `fail`/`blocked` 升级为 `pass`。
