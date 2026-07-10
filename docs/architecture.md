# AI 测试官系统架构

版本：v0.1  
更新时间：2026-07-02  
架构目标：支撑“显式灰度验收 Agent”的 MVP 闭环。

## 1. 架构原则

- 先做固定 Demo 应用，不追求任意仓库泛化。
- 先做可视化可复核，不做黑箱自治。
- 画面证据和结构化证据同时采集。
- 高风险权限必须经过用户确认。
- AI 只给判断和建议，最终裁决权归用户。

## 2. 总体架构

```text
输入层
  - requirement text
  - git diff / PR text
  - app url
  - project path
  - permission profile
  |
  v
上下文与风险层
  - context collector
  - diff analyzer
  - impact mapper
  - risk planner
  |
  v
计划与裁决层
  - oracle builder
  - gray plan generator
  - human review gate
  - permission gate
  |
  v
显式执行层
  - visual gray runner
  - browser controller
  - mouse keyboard controller
  - test command runner
  |
  v
证据采集层
  - screen capture
  - browser evidence collector
  - operation logger
  - evidence store
  |
  v
分析与报告层
  - failure classifier
  - conflict replayer
  - risk coverage matrix
  - report generator
  |
  v
工作台 UI
  - Diff & Context
  - Agent Plan & Actions
  - Live Evidence
```

## 3. 模块说明

### 3.1 `context_collector`

职责：

- 读取需求文本。
- 读取 PR 描述。
- 读取指定 Git diff。
- 读取已有测试和接口说明。

输出：

```json
{
  "requirement_text": "...",
  "diff_text": "...",
  "existing_tests": [],
  "api_contracts": [],
  "known_risks": []
}
```

### 3.2 `diff_analyzer`

职责：

- 解析变更文件。
- 提取改动函数、组件、接口、路由。
- 标记可能影响的业务对象。

输出：

```json
{
  "changed_files": ["src/features/tasks/api.ts"],
  "changed_symbols": ["fetchTasks"],
  "changed_routes": ["/tasks"],
  "changed_api": ["GET /api/tasks"],
  "diff_summary": "任务列表筛选请求逻辑发生变化"
}
```

### 3.3 `impact_mapper`

职责：

- 把代码变更映射到业务路径。
- 生成初步风险清单。

输出：

```json
{
  "impacted_pages": ["任务列表页"],
  "impacted_flows": ["状态筛选", "空状态展示"],
  "risk_items": [
    {
      "id": "risk_filter_completed",
      "level": "high",
      "reason": "筛选请求逻辑被修改，可能漏传 status 参数"
    }
  ]
}
```

### 3.4 `oracle_builder`

职责：

- 为每个测试断言寻找预期来源。
- 区分需求、PR 描述、历史测试、基线行为和 LLM 推断。

断言来源：

- `requirement`
- `pr_description`
- `existing_test`
- `historical_behavior`
- `llm_inferred`

规则：

- `llm_inferred` 必须进入人工确认。
- 没有明确预期来源的断言不能自动阻塞合并。

### 3.5 `gray_plan_generator`

职责：

- 生成显式灰度测试 plan。
- 固定输出 `smoke -> core_path -> edge_case -> regression`。
- 每个路径包含操作、预期、证据和失败策略。

输出示例：

```json
{
  "levels": [
    {
      "id": "core_path",
      "paths": [
        {
          "id": "completed_filter_path",
          "steps": [
            "打开任务列表页",
            "点击已完成筛选",
            "检查 network 是否包含 status=completed",
            "检查页面只显示 completed 任务"
          ],
          "expected_from": "requirement",
          "retry": 1
        }
      ]
    }
  ]
}
```

### 3.6 `human_review_gate`

职责：

- 让用户确认测试 plan。
- 让用户修改、删除、强制加测路径。
- 让用户确认 LLM 推断断言。
- 让用户裁决是否继续下一层灰度。

### 3.7 `permission_gate`

职责：

- 执行权限检查。
- 高风险操作前弹出确认。
- 写入审计日志。

权限等级：

- `observe`
- `browser_control`
- `workspace_control`
- `ide_terminal_control`
- `system_control`

禁止默认执行：

- 删除文件。
- 读取凭据。
- 跨应用操作。
- 安装第三方技能。
- 推送代码。
- 长时间后台自治。

### 3.8 `visual_gray_runner`

职责：

- 按灰度层级执行测试。
- 在执行前显示当前计划。
- 单路径失败后重试。
- 重试失败后继续其他路径。
- 每一步向 UI 发送 Agent Action。

事件流：

```json
{
  "event": "agent_action",
  "path_id": "completed_filter_path",
  "step": "点击已完成筛选",
  "action": "mouse_click",
  "target": "已完成按钮",
  "permission": "browser_control"
}
```

### 3.9 `browser_controller`

职责：

- 打开被测 URL。
- 点击、输入、等待、读取 DOM。
- 采集 browser 内证据。

底层可用：

- Playwright。
- Playwright MCP。
- 浏览器自动化协议。

对外不强调工具名，对用户呈现为可视化脚本执行。

### 3.10 `mouse_keyboard_controller`

职责：

- 记录或执行鼠标点击。
- 记录或执行键盘输入。
- 记录活动窗口和焦点。

MVP 边界：

- 只操作指定浏览器窗口。
- 系统弹窗必须经过确认。
- 不做任意桌面自动化。

### 3.11 `screen_capture`

职责：

- 捕捉指定窗口画面。
- 在关键步骤前后截图。
- 可选录屏片段。
- 记录截图与测试步骤的关联。

输出：

```json
{
  "artifact_type": "screenshot",
  "path_id": "completed_filter_path",
  "step_id": "after_click_completed",
  "file": "reports/screenshots/after_click_completed.png",
  "window": "Browser",
  "timestamp": "..."
}
```

### 3.12 `browser_evidence_collector`

职责：

- 收集 DOM 快照。
- 收集 network 请求和响应。
- 收集 console error。
- 收集 trace。
- 收集断言结果。

### 3.13 `evidence_store`

职责：

- 统一保存所有证据。
- 建立证据与风险、测试路径、步骤的关联。

证据类型：

- `operation`
- `screen`
- `dom`
- `network`
- `console`
- `trace`
- `assertion`
- `test_log`
- `user_decision`

### 3.14 `failure_classifier`

职责：

- 判断失败类别。

类别：

- `product_bug`
- `test_script_bug`
- `selector_broken`
- `environment_error`
- `network_error`
- `flaky_test`
- `uncertain`

### 3.15 `conflict_replayer`

职责：

- 当画面证据和结构化证据冲突时，自动复现同一路径。
- 对比两次证据。
- 生成复核包。

触发条件：

- 截图看起来失败但断言通过。
- DOM 通过但 network 异常。
- 首次失败但重试通过。
- trace 与操作日志不一致。

### 3.16 `report_generator`

职责：

- 生成 Markdown / HTML 报告。
- 输出风险、证据、失败归因、复现步骤、建议动作。

报告结构：

- 总览。
- 关联变更。
- 风险覆盖矩阵。
- 灰度层级结果。
- 失败详情。
- 证据附件。
- 权限与审计日志。
- 用户裁决区。

## 4. 工作台 UI

### 4.1 `Diff & Context`

展示：

- Git diff。
- 需求说明。
- 影响范围。
- 风险来源。

### 4.2 `Agent Plan & Actions`

展示：

- 灰度层级。
- 测试路径。
- 当前执行步骤。
- 下一步操作。
- 需要用户确认的权限。

### 4.3 `Live Evidence`

展示：

- 实时浏览器/窗口画面。
- 关键截图。
- 操作日志。
- network。
- console。
- trace。
- 断言结果。

## 5. 数据流

```text
git diff + requirement
  -> context_collector
  -> diff_analyzer
  -> impact_mapper
  -> oracle_builder
  -> gray_plan_generator
  -> human_review_gate
  -> permission_gate
  -> visual_gray_runner
  -> browser_controller / mouse_keyboard_controller
  -> screen_capture / browser_evidence_collector
  -> evidence_store
  -> failure_classifier / conflict_replayer
  -> report_generator
  -> user verdict
```

## 6. MVP 技术选型建议

- 前端工作台：Vite + React + TypeScript。
- 本地被测应用：同一个 Vite/React 项目或单独 `app-under-test`。
- 浏览器自动化：Playwright。
- 画面捕捉：优先窗口截图和 Playwright video，桌面级捕捉作为增强。
- 后端/编排：Node.js + TypeScript。
- 数据保存：本地 JSON 文件，后续可替换 SQLite。
- 报告：Markdown + HTML。

## 7. 目录建议

```text
project-02-ai-test-officer/
  docs/
    product-spec.md
    demo-script.md
    architecture.md
    blueprint-gap-analysis.md
    frontier-research-pain-points.md
  app-under-test/
  agent/
    context-collector/
    diff-analyzer/
    impact-mapper/
    oracle-builder/
    gray-plan-generator/
    permission-gate/
    visual-gray-runner/
    screen-capture/
    evidence-store/
    report-generator/
  workbench-ui/
  reports/
    screenshots/
    traces/
    videos/
    runs/
  data/
    sample-diffs/
    fixtures/
```

## 8. 首版验收标准

- 能读取一段固定 diff。
- 能识别任务筛选风险。
- 能生成灰度测试 plan。
- 用户能确认 plan。
- 能可视化执行至少 3 条路径。
- 能捕捉截图/录屏或窗口画面。
- 能采集 network、console、trace、DOM 或等价证据。
- 单路径失败后能重试并继续其他路径。
- 能生成包含证据的最终报告。
- 用户能做最终裁决。

