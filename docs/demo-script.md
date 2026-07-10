# AI 测试官 Demo 脚本

版本：v0.1  
更新时间：2026-07-02  
Demo 目标：证明 AI 测试官不是“生成测试按钮”，而是能把一次代码变更转化为可视化、可复核、可裁决的质量证据链。

## 1. Demo 一句话

开发者修改了任务状态筛选逻辑并引入 bug。AI 测试官读取 diff，生成显式灰度测试 plan，接管浏览器鼠标键盘执行测试，捕捉画面和结构化证据，发现“已完成筛选仍显示全部任务”，最后把复现步骤、截图、network 证据和风险建议提交给用户裁决。

## 2. 被测应用

应用：任务管理系统  
推荐技术栈：Vite + React + TypeScript，后端可用本地 JSON / Express / Mock API。

核心页面：

- 任务列表页。
- 新建任务表单。
- 状态筛选控件：全部 / 进行中 / 已完成。
- 空状态提示。
- 接口失败提示。

核心数据：

```json
[
  { "id": 1, "title": "准备答辩材料", "status": "active" },
  { "id": 2, "title": "修复筛选逻辑", "status": "active" },
  { "id": 3, "title": "提交测试报告", "status": "completed" }
]
```

## 3. 故意引入的 bug

需求预期：

> 用户点击“已完成”筛选时，列表只显示 `status=completed` 的任务。

Bug 方案 A：前端漏传参数。

```diff
- fetch(`/api/tasks?status=${status}`)
+ fetch(`/api/tasks`)
```

Bug 方案 B：后端忽略参数。

```diff
- return tasks.filter(task => task.status === status)
+ return tasks
```

推荐使用方案 A，因为 network 证据更直观：点击“已完成”后，请求里没有 `status=completed`。

## 4. Demo 前置准备

需要准备：

- 一份需求说明：状态筛选的验收标准。
- 一段 Git diff：展示筛选逻辑被修改。
- 一个本地应用地址：例如 `http://localhost:5173`。
- 一组固定测试数据。
- 一个用户授权配置：允许浏览器控制、项目测试命令、窗口截图。

## 5. 演示流程

### Step 1：输入上下文

用户在工作台输入或选择：

- `requirement_text`：状态筛选需求。
- `git_diff`：本次筛选逻辑改动。
- `app_url`：本地任务管理系统地址。

工作台左侧展示：

- 需求。
- diff。
- 变更文件。
- 可能影响页面和接口。

### Step 2：AI 生成风险清单

AI 输出：

- 风险 1：状态筛选核心路径受影响。
- 风险 2：空状态可能受影响。
- 风险 3：接口查询参数可能受影响。
- 风险 4：移动端筛选控件可能受影响。

每个风险都要显示证据：

- 来自 diff 的行号或片段。
- 来自需求的预期。
- 来自接口约定或历史测试的参考。

### Step 3：AI 生成显式灰度测试 plan

系统生成固定层级：

```text
Level 1 smoke
  - 打开任务列表页
  - 检查任务列表容器出现
  - 检查 console 无明显错误

Level 2 core_path
  - 点击“已完成”
  - 检查请求包含 status=completed
  - 检查页面只显示 completed 任务

Level 3 edge_case
  - 切换到无数据状态
  - 检查空状态提示
  - 模拟接口失败并检查错误提示

Level 4 regression
  - 再次切回“全部”
  - 检查 active/completed 都出现
  - 新建任务后检查筛选仍正确
```

用户操作：

- 确认计划。
- 删除不需要的路径。
- 强制加测某条路径。
- 授权浏览器控制和窗口捕捉。

### Step 4：Live View 可视化执行

工作台展示：

- `Live View`：浏览器窗口实时画面。
- `Agent Actions`：当前动作，例如“移动鼠标到已完成按钮并点击”。
- `Evidence Panel`：截图、network、console、trace、断言结果。

Agent 执行：

1. 打开任务列表页。
2. 截图：页面初始状态。
3. 点击“已完成”。
4. 截图：筛选后状态。
5. 记录 network 请求。
6. 读取列表 DOM。
7. 判断是否只显示 completed 任务。

### Step 5：触发失败

预期：

- 请求包含 `status=completed`。
- 页面只显示“提交测试报告”。

实际：

- 请求没有 `status=completed`。
- 页面仍显示 active 和 completed 的全部任务。

系统记录：

- 点击坐标。
- 操作前截图。
- 操作后截图。
- network 请求 URL。
- DOM 列表文本。
- console 日志。
- trace。

### Step 6：失败重试

系统自动重试一次同一路径：

- 重新进入页面。
- 重新点击“已完成”。
- 再次采集画面和 network。

如果仍失败：

- 标记 `core_path` 失败。
- 记录候选原因：前端请求漏传筛选参数。
- 不终止整轮测试。
- 继续执行 `edge_case` 和 `regression` 中可执行路径。

### Step 7：最终报告

报告必须包含：

```text
结论：hold_for_review

核心失败：
  - 已完成状态筛选失败

复现步骤：
  1. 打开任务列表页
  2. 点击“已完成”
  3. 观察任务列表

预期：
  - 只显示 completed 任务
  - 请求包含 status=completed

实际：
  - 仍显示全部任务
  - 请求缺少 status=completed

证据：
  - 操作录屏
  - 操作前后截图
  - network 请求
  - DOM 文本
  - trace

疑似原因：
  - 前端筛选请求未携带 status 参数

建议动作：
  - 阻塞合并或人工复核
  - 修复后重跑 core_path 和 regression
```

### Step 8：用户裁决

用户可以选择：

- `accept_report`：接受报告。
- `rerun_failed_path`：重跑失败路径。
- `mark_false_positive`：标记为误报。
- `block_merge`：阻塞合并。
- `continue_with_note`：带备注继续。

AI 不直接决定是否发布，只提交证据和建议。

## 6. 答辩讲法

推荐讲法：

> 传统自动化测试只能跑预先写好的脚本，Codex/Cursor 可以帮开发写测试，但它们没有天然回答“这次变更到底有没有测够”。我们的 AI 测试官从 Git diff 出发，先判断风险，再生成显式灰度测试计划，接管浏览器像测试人员一样逐步操作，并捕捉画面、network、console 和 trace 形成证据链。最后，系统不替人裁决，而是把可复核报告交给用户决定是否合并。

## 7. 演示成功标准

必须满足：

- diff 能被解析并关联到状态筛选风险。
- 测试 plan 包含固定灰度层级。
- Live View 能展示可视化操作过程。
- 至少一次核心路径失败能被捕捉。
- 失败后自动重试，仍失败后继续其他路径。
- 报告包含画面证据和结构化证据。
- 用户能做最终裁决。

## 8. 演示风险与备用方案

风险：桌面录屏权限临场失败。  
备用：使用浏览器窗口截图 + Playwright video + 操作日志模拟 Live View。

风险：网络请求采集失败。  
备用：展示 DOM 断言和截图证据。

风险：自动鼠标操作不稳定。  
备用：用 Playwright 驱动浏览器，但 UI 中仍展示 Agent Actions 和 Live View。

风险：模型输出不稳定。  
备用：准备固定 JSON plan，现场演示“AI 生成结果已确认”的流程。

