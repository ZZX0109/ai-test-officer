# 自主测试主链过渡代码审计

更新时间：2026-08-12

## 产品主链

正式交互链路必须保持为：

`代码业务识别 → 运行诊断 → 计划确认 → LangGraph → 共享 Playwright 会话 → Oracle/Proof → 恢复或修复 → 最终结论`

规则层负责权限、动作执行和机器结论；LLM 负责目标定位、动态动作、失败解释和修复建议。任何兼容分支都不得跳过 Coverage、Attempt、Oracle、Evidence 或 Graph finalization。

## 已确认并修复的过渡阻断

1. **登录页被 Discovery 当作终态**
   - 原行为：页面已经成功打开且识别出登录控件，但 Discovery 设置终态，Graph 在 Browser Action Broker 之前结束。
   - 当前行为：已确认的动态浏览器运行继续进入共享 Playwright 会话；保存过的测试账号可直接注入，没有账号时才产生凭据 interrupt。

2. **不可执行业务候选进入浏览器队列**
   - 原行为：前端只传路径 ID，`needs-input` 和 `coverage-gap` 与可执行路径没有区别，导致 Graph 逐条尝试本来就没有动作或 Oracle 的候选。
   - 当前行为：规划状态进入 Run 契约；只有 `executable` 和 `auto-bindable` 可进入待执行状态，其余路径保留为明确 blocked disposition。

3. **LLM Planner 失败回退丢失业务清单**
   - 原行为：动态 fallback 没有携带 `coverageInventory`，全面扫描可能退化为单条通用浏览器路径。
   - 当前行为：回退保留完整代码归并清单、来源和状态，不再静默缩小测试范围。

4. **普通动作被模型风险标签误暂停**
   - 当前策略：确定性 Browser Action Policy 是权限权威。普通点击、非敏感填写、滚动和同源导航自动执行；凭据、不可逆动作和源码/网络能力仍需确认。

5. **Workbench 展示旧 Run 的阻塞结果**
   - 当前策略：项目最新持久化 Run 优先于本地缓存；终态报告到达后清理同一运行的临时阻塞消息。后端成功而界面仍显示旧安全阻塞不再作为真实状态。

## 仍需移除的结构性过渡层

1. **动态页面路径已迁移到独立 child Graph**
   - 动态 parent 在权限确认后由 Worker 只负责按 CoverageItem 调度；每条可执行页面路径创建确定性的 path child run。
   - child 拥有独立 Browser Graph、Attempt、LLM budget、Evidence 和 Machine Gate，parent 只聚合 disposition 与 Proof。
   - `needs-input`、`coverage-gap` 和未绑定的非页面候选仍保留为明确 blocked，不会伪装成可执行路径。

2. **`auto-bindable` 仍不等于真实运行时绑定**
   - Runtime Binding Compiler 已输出结构化状态、入口、Capability、Oracle 和预算，但动态页面的控件绑定仍在 child Graph 的真实 Observation 阶段完成。
   - 只有已进入可执行 disposition 的页面候选才创建 child；绑定失败保留真实 observation 和缺失项。

3. **`POST /v1/runs` 仍同步推进确认事件**
   - Active 模式已经由 Graph 决定最终状态，但 API 为避免重复审批，仍会在启动 Graph 前同步调用规划并写入 `plan_approved`/`permission_granted`。
   - 正式方案：把 `confirmedExecution` 作为 Graph 初始输入，由 Graph 节点独占写入审批事件；API 只创建 Run 和启动 thread。

4. **前端仍同时维护 PlanningAutomation 与 durable Run 状态**
   - 当前已增加持久化 Run 恢复，但 `App.tsx` 中仍有本地 blocked/ready 状态参与展示。
   - 正式方案：运行开始后 UI 只投影 Graph/Run/SSE；本地状态只管理输入框、抽屉和 loading，不产生测试结论。

5. **旧非 OCI Scenario 分支仍与动态 Graph 分支并存**
   - 该分支用于固定 fixture 和历史 Scenario Registry，不能删除，但必须限制到显式固定场景，禁止未知上传项目自动落入。

## 禁止的回退行为

- 不得把登录页、空页面或控件未绑定直接描述为产品缺陷。
- 不得用一条通用动态路径替代完整业务清单。
- 不得把 `needs-input` 或 `coverage-gap` 作为可执行页面动作。
- 不得因 LLM 不可用而丢弃已识别 CoverageItem。
- 不得由前端、Worker 和 Graph 同时写最终结论。
- 不得用旧 Run、旧 Attempt 或本地缓存覆盖当前持久化结果。
- 不得为了“顺利完成”降低 Proof Bundle 或 Machine Gate；应修复执行编排，而不是伪造通过。
