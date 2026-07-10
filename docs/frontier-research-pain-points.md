# AI 测试官：前沿研究痛点与项目实现范围

更新时间：2026-07-02  
项目定位：提交前代码变更质检 Agent。输入需求、Git diff/PR、本地应用地址，输出可复核的测试计划、执行证据、风险报告与人工裁决建议。

## 1. 结论先行

这个项目不能只做成“Codex/Cursor 的测试生成按钮”。如果只是让 LLM 写几个单测或 Playwright 脚本，它很容易变成代码助手的从属功能。

更有辨识度的定位是：

> 把一次代码变更转化为可验证、可追责、可复核的质量证据链。

Codex/Cursor/通用 AI Agent 工作流平台主要回答“代码怎么写”或“任务怎么自动执行”。AI 测试官应该回答：

- 这次变更影响了哪些业务路径？
- 哪些风险必须测，哪些可以延后？
- 哪些测试结论有证据，哪些只是推断？
- 当前证据是否足以支持合并、发布或灰度？
- 人类最终裁决时，能不能快速复核 AI 的判断？

## 2. 前沿研究暴露出的核心痛点

### 痛点一：真实软件问题需要跨文件、跨上下文理解

SWE-bench 表明，真实 GitHub issue/PR 往往要求模型理解多个文件、函数和类之间的联动，而不是只看一个代码片段。真实仓库任务还需要模型与执行环境交互、处理长上下文、运行测试并解释结果。

对本项目的启发：

- Git diff 只能作为入口，不能作为唯一上下文。
- AI 测试官需要把 diff 与需求文档、路由、接口、组件、旧测试、历史 bug 连接起来。
- 报告里必须区分“直接由 diff 支撑的结论”和“由上下文推断的结论”。

项目实现要求：

- `diff_analyzer`：解析改动文件、函数、组件、接口、路由。
- `impact_mapper`：建立变更到业务路径的影响映射。
- `context_collector`：读取 PR 描述、需求说明、已有测试、接口文档。
- `evidence_graph`：记录每个风险判断来自哪些证据。

来源：

- SWE-bench: Can Language Models Resolve Real-World GitHub Issues?  
  https://arxiv.org/abs/2310.06770

### 痛点二：Agent 不是越复杂越好，工具界面和可解释流程更重要

SWE-agent 强调 Agent 需要适合自己的 Agent-Computer Interface，才能有效浏览仓库、编辑文件、运行测试。Agentless 又从另一个方向提醒：复杂自主 Agent 不一定总是必要，简单、可解释、低成本的定位-修复-验证流程也可能更强。

对本项目的启发：

- 不要把“多 Agent 自动乱跑”当作创新点。
- 重点应该是让测试决策过程可观察、可回放、可人工接管。
- 产品形态可以像 Codex/Cursor/AI Agent 工作流平台，但任务范式应是“质量审查工作台”，不是“聊天写代码”。

项目实现要求：

- 左侧：Git diff、需求、PR 描述。
- 中间：AI 生成的风险清单、测试计划、证据链。
- 右侧：执行过程、截图、trace、日志、最终报告。
- 所有 AI 决策都要显示理由：为什么测、为什么不测、证据是什么。
- 人可以确认、删除、调整测试计划，再执行。

来源：

- SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering  
  https://arxiv.org/abs/2405.15793
- Agentless: Demystifying LLM-based Software Engineering Agents  
  https://arxiv.org/abs/2407.01489

### 痛点三：测试生成不难，可信的测试 Oracle 才难

LLM 可以生成测试代码，但真正困难的是判断“什么才算对”。测试 Oracle 指的是测试中的预期行为或断言依据。没有可靠 Oracle，AI 可能生成看似合理但验证目标错误的测试。

WebTestPilot 把这个问题放在 E2E Web 测试里讨论：如果 Agent 发现页面行为和自然语言需求不一致，很难判断这是应用 bug，还是 Agent 自己理解错了。它通过 GUI 元素符号化、步骤前后置条件等方式，把隐式预期变成更可验证的条件。

对本项目的启发：

- 不能只让 AI 写 `expect(...)`。
- 每个断言必须标注预期来源。
- 如果预期来自模型推断，必须进入“需要人工确认”状态。

项目实现要求：

- `oracle_builder`：把需求/PR/历史测试转成可验证预期。
- `assertion_source`：为每条断言记录来源：
  - `requirement`：来自需求文档。
  - `pr_description`：来自 PR 描述。
  - `existing_test`：来自已有测试。
  - `historical_behavior`：来自基线版本行为。
  - `llm_inferred`：来自模型推断，必须人工确认。
- `human_review_gate`：允许用户确认或修改关键断言。

来源：

- WebTestPilot: Agentic End-to-End Web Testing against Natural Language Specification by Inferring Oracles with Symbolized GUI Elements  
  https://arxiv.org/abs/2602.11724
- Challenges in Testing Large Language Model Based Software: A Faceted Taxonomy  
  https://arxiv.org/abs/2503.00481

### 痛点四：覆盖率有帮助，但覆盖率不是质量判断的终点

CoverUp 说明，将覆盖率反馈与 LLM 结合，可以更有效地生成覆盖未触达代码分支的回归测试。Meta 的 TestGen-LLM 也说明，LLM 生成测试需要经过构建、可靠性、覆盖率提升等过滤器，不能直接信任模型输出。

对本项目的启发：

- 覆盖率是证据，不是最终裁决。
- 更重要的是“本次变更的高风险路径是否被覆盖”。
- 测试报告应输出风险覆盖，而不只是代码覆盖。

项目实现要求：

- `coverage_collector`：收集行覆盖、分支覆盖、E2E 路径覆盖。
- `risk_coverage_matrix`：风险点与测试用例的映射表。
- `test_filter`：过滤无法构建、不稳定、无明确断言、无覆盖提升的 AI 生成测试。
- `quality_score`：把通过率、风险覆盖、失败严重度、证据完整度综合为发布建议。

来源：

- CoverUp: Coverage-Guided LLM-Based Test Generation  
  https://arxiv.org/abs/2403.16218
- Automated Unit Test Improvement using Large Language Models at Meta / TestGen-LLM  
  https://arxiv.org/abs/2402.09171

### 痛点五：真实项目的测试执行环境很脆弱

ExecutionAgent 指出，自动构建和运行任意项目的测试并不简单。不同语言、依赖、脚本、环境变量、容器、数据库都会让“自动跑测试”变成一个工程问题。

对本项目的启发：

- Demo 阶段不要追求支持任意项目。
- 应先锁定一个被测应用和一套稳定工具链。
- 执行失败必须归因：是产品 bug、测试脚本问题、选择器失效、环境问题，还是依赖问题。

项目实现要求：

- `test_runner`：统一执行 `npm test`、`vitest`、`playwright test`。
- `environment_checker`：检查依赖、端口、服务启动、数据库种子数据。
- `failure_classifier`：区分：
  - `product_bug`
  - `test_script_bug`
  - `selector_broken`
  - `environment_error`
  - `network_error`
  - `flaky_test`
- `retry_policy`：对疑似 flaky 或环境问题执行有限重试。

来源：

- You Name It, I Run It: An LLM Agent to Execute Tests of Arbitrary Projects  
  https://arxiv.org/abs/2412.10133

### 痛点六：LLM/Agent 的结果具有不稳定性，不能只看单次执行

LLM 测试研究指出，LLM 系统具有非确定性，测试结果不应总被当作一次性、二元的 pass/fail。对于 AI 参与生成或判断的测试，需要记录模型版本、提示词、参数、执行次数、重复结果与聚合结论。

对本项目的启发：

- AI 判断不能只输出“通过/失败”。
- 报告要显示置信度、重复执行结果、证据完整度。
- 对关键路径可以做多次运行和聚合判断。

项目实现要求：

- `run_history`：保存每次测试的模型、prompt、commit、环境、时间戳。
- `repeat_runner`：对关键用例重复执行 2-3 次。
- `aggregated_verdict`：输出聚合结论，而非单次结论。
- `audit_log`：记录人工修改了哪些测试计划或断言。

来源：

- Challenges in Testing Large Language Model Based Software: A Faceted Taxonomy  
  https://arxiv.org/abs/2503.00481

## 3. 本项目需要实现的内容

### MVP 必须实现

1. 固定一个小型被测应用
   - 建议：任务管理系统或订单管理后台。
   - 核心业务：列表筛选、状态变更、表单提交、接口失败兜底。
   - 必须准备一个可触发真实 bug 的 diff。

2. 变更理解
   - 输入 Git diff / PR 文本。
   - 输出改动文件、改动函数、影响页面、影响接口、疑似风险点。

3. 风险到测试计划
   - 把风险点转成测试场景。
   - 区分必测、建议测、可延后。
   - 每个测试场景必须有理由和预期来源。

4. 人工确认
   - 用户可以勾选、删除、修改测试计划。
   - 对 LLM 推断出的断言，必须要求人工确认。

5. 执行验证
   - 自动运行已有单测或集成测试。
   - 自动运行 Playwright E2E 测试。
   - 保存截图、trace、console log、network log。

6. 失败归因
   - 判断失败是产品问题、测试脚本问题、选择器问题、环境问题还是偶发问题。

7. 可复核报告
   - 输出风险等级、通过率、失败详情、证据附件、复现步骤、建议动作。
   - 明确给出“建议合并 / 建议阻塞 / 建议人工复核”。

### 高分增强项

1. 风险覆盖矩阵
   - 展示每个风险点是否被测试覆盖。
   - 比单纯覆盖率更贴合质量决策。

2. 基线版本对比
   - 在变更前版本和变更后版本分别跑同一测试。
   - 如果旧版本通过、新版本失败，更能证明是本次变更引入的问题。

3. 视觉证据链
   - 页面截图。
   - 关键步骤录屏。
   - DOM 快照。
   - Playwright trace。

4. 自愈选择器
   - 如果选择器失败，尝试 role、label、text、test id、相邻 DOM 结构。
   - 自愈后必须记录“原选择器失败，新选择器为何可信”。

5. 发布/灰度建议
   - 根据测试结果和风险等级输出建议：
     - 可以合并。
     - 可以小流量灰度。
     - 需要补测后再合并。
     - 阻塞发布。

## 4. 显式灰度测试：Agent 接管鼠标键盘的分层验证

这里的“显式灰度测试”不是线上流量灰度，也不是只做 baseline/candidate 双版本对比，而是：

> Agent 像真实测试人员一样接管鼠标、键盘和浏览器窗口，从低风险路径到高风险路径逐步操作应用，并在每一步采集画面、日志、网络请求和断言证据。

它的重点是“显式”：

- 显式展示 Agent 当前准备测什么。
- 显式展示 Agent 为什么先测这个路径。
- 显式展示 Agent 如何移动鼠标、点击、输入、等待和观察。
- 显式展示每一步的画面证据和结构化证据。
- 显式让人决定是否继续进入下一层风险测试。

### 为什么它有价值

这种灰度测试能把项目从“自动跑脚本”升级成“可观察的 AI 测试同事”。它比普通 Playwright 更适合答辩展示，也更容易和 Codex/Cursor 拉开差异：

- Codex/Cursor 更像开发助手，主要关注代码如何生成和修改。
- AI 测试官更像质量门禁，关注一次变更是否经得起真实操作验证。
- 鼠标键盘接管让评委看到 Agent 真的在执行前端体验验证，而不是后台悄悄跑脚本。

### MVP 灰度测试可以这样做

把一次测试计划拆成三层灰度：

1. `gray_level_1_smoke`
   - 只测页面能否打开、核心元素是否出现、无明显 console error。
   - 操作轻量，失败则停止后续测试。

2. `gray_level_2_core_path`
   - 测本次 diff 直接影响的核心路径。
   - 例如任务状态筛选、订单筛选、表单提交。
   - Agent 使用鼠标点击、键盘输入、页面观察完成验证。

3. `gray_level_3_edge_and_regression`
   - 测边界条件、异常输入、空状态、移动端视口、接口失败兜底。
   - 只有前两层通过或经人工确认后才继续。

每一层输出：

- `planned_action`：准备执行的操作。
- `risk_reason`：为什么这一层要测。
- `screen_evidence`：操作前后屏幕截图或录屏片段。
- `structured_evidence`：DOM、network、console、trace、断言结果。
- `human_gate`：是否需要人确认继续。
- `verdict`：`continue` / `hold_for_review` / `stop_and_fix`。

### 与双版本对比的关系

双版本对比仍然有价值，但它不是这个项目里“显式灰度测试”的核心定义。更准确的关系是：

- 鼠标键盘接管：负责像人一样执行真实操作。
- 捕捉电脑画面：负责记录真实操作过程。
- Playwright/浏览器协议：负责采集结构化证据。
- baseline/candidate 对比：作为增强能力，用来证明问题是否由本次变更引入。

### 注意边界

- 不要真的接生产流量。
- 不要承诺 Agent 可以完全替代人工测试。
- 不要只靠视觉截图做最终判定。
- 鼠标键盘操作必须和 DOM/network/console/trace 证据绑定，否则容易变成演示动画。

## 5. 捕捉电脑画面：必须加入的证据采集层

捕捉电脑画面应该作为本项目的必选能力，而不是可选增强。它解决的是“AI 测试过程是否可见、可复核、可信”的问题。

### 为什么它有帮助

Playwright 能稳定捕捉浏览器内行为，但如果产品形态接近 AI Agent 工作流平台或 Cursor，用户和评委需要看到 Agent 正在真实接管电脑完成测试。画面捕捉可以补足这些证据：

- 展示 Agent 正在操作哪个页面。
- 展示鼠标移动、点击、键盘输入和等待过程。
- 记录测试失败前后的视觉状态。
- 捕捉浏览器外的提示，例如系统弹窗、IDE、终端错误。
- 让报告更像“现场取证”，评委一眼能理解。

这与 WebTestPilot 的方向相近：把 GUI 观察转成可验证状态，而不是只依赖日志。

### 但它不能替代结构化证据

屏幕画面有三个问题：

- 难以稳定断言。
- 容易受分辨率、主题、窗口位置影响。
- 有隐私风险，可能截到无关内容。

所以更合理的证据分层是：

1. 操作证据：鼠标轨迹、点击位置、键盘输入、窗口焦点。
2. 画面证据：桌面截图、指定窗口截图、关键步骤录屏。
3. 浏览器证据：DOM、locator、network、console、trace。
4. 业务证据：断言结果、接口返回、数据变化、风险覆盖矩阵。

### 推荐实现方式

MVP 必须同时做两层：

第一层，浏览器内证据：

- `page.screenshot()`
- `video`
- `trace`
- `console` 事件
- `requestfailed` / `response` 事件

第二层，桌面/窗口画面证据：

- macOS 屏幕录制或截图权限。
- 截取指定窗口，而不是全屏。
- 记录鼠标点击坐标、键盘输入摘要、当前活动窗口。
- 自动打码或裁剪无关区域。
- 报告中标注：画面证据用于复核过程，最终判定仍需结合结构化证据。

### 对产品形态的影响

工作台界面应显式展示三块内容：

- `Live View`：实时电脑画面或浏览器窗口画面。
- `Agent Actions`：当前鼠标/键盘操作、等待、观察、下一步计划。
- `Evidence Panel`：截图、trace、network、console、断言和风险覆盖。

这会让项目更像“AI 测试官正在现场验收”，而不是一个后台自动化测试脚本。

## 6. 推荐 Demo 主线

最稳妥的 Demo：

1. 准备一个任务管理系统。
2. 提交一个 diff：修改任务状态筛选逻辑。
3. 故意引入 bug：点击“已完成”后仍显示全部任务，或接口漏传 `status=completed`。
4. AI 测试官读取 diff。
5. AI 输出风险：
   - 状态筛选路径受影响。
   - 空状态可能受影响。
   - 移动端筛选控件可能受影响。
   - 接口查询参数可能受影响。
6. 用户确认测试计划。
7. 系统运行 Playwright。
8. 系统发现 candidate 版本失败，baseline 版本通过。
9. 报告输出：
   - 失败复现步骤。
   - 请求参数证据。
   - 页面截图。
   - trace 链接。
   - 疑似代码位置。
   - 灰度建议：`hold_for_review` 或 `rollback_recommended`。

这条线能同时展示：

- Git diff 理解。
- 测试计划生成。
- E2E 自动执行。
- 视觉/日志证据。
- 基线对比。
- 人类最终裁决。

## 7. 最终产品边界

本项目应该避免承诺：

- 自动保证软件质量。
- 自动决定线上发布。
- 自动理解所有业务需求。
- 支持任意复杂仓库。
- 仅靠截图判断业务正确性。

本项目应该明确承诺：

- 自动发现本次变更的高风险路径。
- 自动生成可复核测试计划。
- 自动执行一组可观察测试。
- 自动采集证据并归因失败。
- 帮助人类更快做发布/合并决策。

## 8. 一句话答辩表述

> 现有 AI 编程工具主要解决“怎么把代码写出来”，但提交前最痛的是“这次改动到底有没有测够、风险在哪里、证据能不能支撑发布”。AI 测试官从 Git diff 出发，结合需求、历史测试和浏览器执行结果，生成风险驱动的测试计划，执行前后端验证，并用截图、trace、日志和基线对比形成可复核的质量证据链，最终由人类裁决是否合并或灰度。

## 9. 已确认产品原则

### 原则一：权限模型参考 Codex / Claude Code，而不是 OpenClaw 式泛化接管

Agent 可以操作浏览器、IDE、终端和必要的系统弹窗，但必须遵守分级权限：

- `observe`：只观察画面、读取状态、采集日志，不执行操作。
- `browser_control`：允许操作浏览器窗口和被测应用。
- `workspace_control`：允许读取/运行当前项目内命令，例如测试、构建、启动服务。
- `ide_terminal_control`：允许操作 IDE、终端和测试工具，但需要用户确认。
- `system_control`：涉及系统弹窗、权限授权、跨应用操作、文件删除、网络访问、凭据访问时必须显式询问用户。

OpenClaw 类工具的主要风险来自长期自治、第三方技能、过宽系统权限、远程触发和不透明执行。本项目应避免这些风险：

- 不安装未经验证的第三方技能。
- 不默认跨应用操作。
- 不默认读取敏感目录、凭据、浏览器密码或聊天记录。
- 不允许后台长期自治执行。
- 每次高风险操作前显示原因、影响范围和可取消按钮。
- 所有鼠标、键盘、终端和文件操作写入审计日志。

来源参考：

- Codex sandboxing and approvals  
  https://developers.openai.com/codex/concepts/sandboxing
- Codex agent approvals and security  
  https://developers.openai.com/codex/agent-approvals-security
- Claude Code permissions  
  https://code.claude.com/docs/en/permissions
- OpenClaw security risks, community skills and autonomous access  
  https://www.techradar.com/pro/security/multiple-malicious-openclaw-skills-found-online-including-two-macos-infostealers

### 原则二：画面捕捉用于可视化和复核，不单独作为最终判定

画面捕捉的主要作用是：

- 让用户实时看见测试过程。
- 在测试完成后向用户提交可复核证据。
- 记录 Agent 的鼠标、键盘、窗口焦点和页面状态。
- 辅助解释为什么某个测试失败。

当截图/录屏与 DOM、network、console、trace 等结构化证据冲突时，系统不应直接裁决，而应进入复核流程：

1. 自动复现同一路径。
2. 对比两次画面和结构化证据。
3. 尝试定位冲突来源，例如异步加载、视觉延迟、选择器错误、网络失败、页面遮挡。
4. 如果仍无法确定，把冲突证据提交给用户判断。

### 原则三：最终裁决权属于用户

系统必须内置固定灰度层级，但每一层是否执行、是否继续、是否阻塞，最终由用户决定。

推荐固定层级：

1. `smoke`：页面打开、核心元素出现、无明显错误。
2. `core_path`：本次 diff 直接影响的核心业务路径。
3. `edge_case`：空状态、异常输入、权限、接口失败、移动端视口。
4. `regression`：历史高风险路径和相关旧用例。

Agent 的职责是从高风险到低风险判断“建议做到哪一层”，并解释理由。用户可以：

- 强制加测。
- 跳过某层。
- 调整优先级。
- 修改测试路径。
- 决定是否接受报告结论。

### 原则四：Playwright 是底层执行能力，产品上必须呈现为可视化脚本执行

用户不需要理解 Playwright。产品上应表现为：

- AI 先生成测试 plan。
- AI 展开每条详细测试路径。
- AI 在 Live View 中可视化执行鼠标、键盘和浏览器操作。
- 右侧同步显示当前步骤、预期、观察结果和证据。

Playwright 可以作为底层浏览器自动化引擎，负责稳定执行点击、输入、断言、截图、trace、network 和 console 采集。但对外叙事不应是“我们用了 Playwright”，而应是：

> AI 测试官把测试计划转化为可视化执行脚本，并在真实页面上逐步验收。

### 原则五：单路径失败后重试，仍失败则继续执行其他路径

测试执行前必须先生成完整测试 plan 和详细路径。执行过程中：

1. 单个路径失败后，先自动重试。
2. 重试仍失败，则记录失败证据、失败原因候选和复现步骤。
3. 不立即终止整轮测试，继续执行下一个测试路径。
4. 全部路径执行完后统一归因，区分单点失败、系统性失败、环境失败和测试脚本失败。
5. 如果失败路径属于 `smoke` 层或阻塞级核心路径，可以提示用户是否提前停止，但默认仍保留“继续收集证据”的选项。

这样可以避免两种问题：

- 一遇到失败就停，证据太少。
- 无视严重失败一直跑，浪费时间。

最终报告应同时给出：

- 单路径结论。
- 分层灰度结论。
- 整体风险结论。
- 需要用户裁决的问题。
