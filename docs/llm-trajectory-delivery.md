# LLM 传输与全局轨迹交付说明

本文是普通 Chat Completions、Codex Responses、Anthropic Messages 和 Agent
Tool Gateway 的运行约定。它也可以作为桌面 Harness 的验收清单。

## 当前链路

```text
Run/子 Run
  → executeLlmCall / executeLlmCallWithTools
  → 统一 transport adapter（SSE 或 JSON）
  → llm.request / llm.chunk / llm.response
  → ToolGateway（校验、权限、审批、超时、取消、幂等）
  → trajectory_events（追加式、脱敏、rootSeq 全局序号）
  → REST 分页或 SSE 增量
  → Workbench 规划对话右侧「轨迹」切换面板
```

每个事件同时记录 `runSeq`（单 Run 序号）和 `rootSeq`（父 Run + 全部子
Run 的连续序号），并带 `parentRunId`、`rootRunId`。因此子 Run 不再只靠聚合
查询拼接；SSE 断线后使用 `Last-Event-Root-Seq` 即可继续。

## 供应商能力矩阵

| 供应商/模型 | 端点与流式 | 原生工具格式 | 结构化输出 | 失败策略 |
| --- | --- | --- | --- | --- |
| `openai`、`openrouter`、普通 `openai-compatible`、自定义兼容网关 | `/chat/completions`，SSE `data:` + `[DONE]` | `tool_calls[].function` | `response_format.json_schema`；SophNet 使用 `json_object` | `stream → stream retry → non-stream` |
| `openai`/`openai-compatible` 且模型名含 `codex` | `/responses`，Responses SSE | `function_call` / `function_call_output` | `text.format` JSON Schema | 同上 |
| `anthropic` | `/messages`，Messages SSE | `tool_use` / `tool_result` | 由调用方 Schema 校验 | 同上 |

机器可读版本在 [`agent/src/llmCapabilityMatrix.ts`](../agent/src/llmCapabilityMatrix.ts)。
运行中的 Agent 也通过只读 `GET /api/llm-capabilities` 暴露这份矩阵。
实际 adapter 会在请求前选择端点，并把三种供应商的增量统一为：
`text_delta`、`reasoning_delta`、`tool_call_delta`、`completed`。

### 模式配置

- `auto`（生产默认）：先真实 token 流式；流中断、空响应、供应商 5xx/限流或
  超时才按策略重试，最后一次使用非流式兜底。
- `stream`：只允许一次流式调用，适合需要严格低延迟且由上层自行重试的场景。
- `non-stream`：只发一次完整 JSON 请求。
- `non-stream-retry`：仅兼容旧的预检/供应商特殊路径，不是生产默认。

默认单次模型请求超时来自 `LLM_REQUEST_TIMEOUT_MS`（未设置时 30 秒）；调用方可
用 `timeoutMs`/`totalTimeoutMs` 做更细的预算控制。

流式和非流式最终都返回同一个 normalized response（文本、工具调用、usage），
所以业务层不需要分叉解析逻辑。调用方可传 `AbortSignal`；取消会产生
`llm.response(status=error,errorCode=llm_cancelled)`，不会再触发重试。

## 原生 Tool Calling 与安全边界

模型只能提出工具调用，实际执行始终经过 `ToolGateway`：

- allow-list + JSON Schema/类型校验 + 当前 Run/Project 作用域校验；
- `browser.observe`、`browser.act`、`api.request`、`test.run`、断言、fixture、
  visual、artifact、evidence 及知识读取等能力统一注册；
- 写操作返回 `needs-confirmation`，等待用户批准后用同一 `callId` 恢复；
- `TOOL_GATEWAY_TIMEOUT_MS` 默认 60 秒（范围 1ms–300s），单次可用
  `timeoutMs` 覆盖；支持 `AbortSignal` 取消；
- `idempotencyKey` 重放返回之前结果，避免副作用重复执行；
- `tool.call` 事件记录提议参数，完成/失败事件记录状态、错误码、耗时、证据引用
  和脱敏后的 `outputPreview`（最多约 8KB），不会把密钥写入轨迹。

通用循环入口是 `executeLlmCallWithTools`。Judge 的 `get_evidence` 已接入原生
工具；浏览器规划/动作目前仍可继续使用既有结构化 JSON DSL，也可以按调用方
allow-list 切换为原生工具循环。

## 轨迹 REST/SSE 使用

```http
GET /v1/runs/{runId}/trajectory?scope=tree&afterRootSeq=120&limit=200
GET /v1/runs/{runId}/trajectory/stream?scope=tree
Last-Event-Root-Seq: 120
```

SSE 先补发游标之后的事件，再发送 `trajectory.snapshot`；客户端收到实时事件后
用防抖 REST 重建投影，避免每个 token 都触发全量渲染。`scope=run` 只看当前 Run，
`scope=tree` 看根 Run 及所有后代。事件存储是追加式，重复
`(runId,idempotencyKey)` 不会产生第二条事件。

## 保留、脱敏与运维配置

- 事件 payload 在落库前统一脱敏并限制深度/长度；密钥、Authorization、Cookie 等
  不进入轨迹。大文件、截图和 HAR 只保存引用，正文放 Artifact Store。
- 当前实现不在请求路径自动删除轨迹；生产建议按组织/项目做分区或归档，在线保留
  30–90 天，归档后再按合规策略删除。删除必须在离线维护窗口执行，并保留审计摘要。
- SQLite 本地模式使用 `reports/trajectory.sqlite`；Postgres 运行迁移后使用
  `trajectory_events` 与 `trajectory_root_sequences`，并由 append-only trigger
  防止更新/删除。
- API key 只从 credential 解密层传入 adapter；日志、事件和前端只展示 mask/摘要。

## 迁移、回滚与验收

```bash
npm --prefix agent run migrate
npm --prefix agent run typecheck
npm --prefix agent test
npm --prefix workbench-ui run typecheck
npm --prefix workbench-ui test -- --run
```

迁移文件为 [`agent/migrations/1785500000000_trajectory_events.cjs`](../agent/migrations/1785500000000_trajectory_events.cjs)，
包含事件表、根序列表、索引和 append-only trigger，`down` 可回滚新建表。
回滚前必须先停止写入并导出轨迹；回滚会丢失该迁移创建的轨迹数据，不应在生产
在线执行。应用发布采用“先迁移、后代码、失败时切回旧应用但保留新表”的顺序。

验收至少覆盖：三种供应商 SSE、流式失败后的非流兜底、流式/非流式结果一致、三种
工具调用格式、拒绝/审批/超时/取消/幂等、父子 Run 的 `rootSeq` 连续性、SSE 断点
续传、重启后序号恢复、脱敏，以及桌面规划对话右侧轨迹切换。
