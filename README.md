# AI Test Officer

AI Test Officer 是一个面向提交前质量验证的 AI 测试工作台。它读取需求、Git diff、Bug/Issue、OpenAPI 或 PR 上下文，生成可执行的灰度测试计划，驱动独立的被测应用执行浏览器测试，采集截图、DOM、network、console、trace 和运行日志，最后输出带证据引用的风险判断和发布建议。

它不是“点击一下就替你批准合并”的黑箱 Agent。设计目标是让 Agent 的每个动作、每个断言、每条证据和每次 Judge 降级都可以在 Workbench 里被人复核。

![AI Test Officer workbench](docs/assets/ai-test-officer-workbench.png)

## 项目亮点

- **需求到执行闭环**：需求/PR/diff -> 影响面 -> 灰度计划 -> Playwright 执行 -> 证据包 -> release gate。
- **独立被测应用**：`app-under-test` 是独立的任务管理应用和 mock API，不是 Agent 自己渲染出来的假测试结果。
- **结构化证据链**：每一步测试动作都可以关联 screenshot、DOM、network、console、trace、断言和 source context。
- **分层 Judge**：plan Judge、evidence Judge、release Judge 分开输出，并显式展示 `llm_assisted`、`fallback_baseline` 或 deterministic 的执行模式。
- **失败归因**：尝试区分 `product_bug`、`test_script_issue`、`environment_issue`、`insufficient_evidence` 和未知失败。
- **VS Code 风格 Workbench**：深色编辑器画布、活动栏、命令面板、代码/diff 视图和 Live View，适合持续操作而不是一次性表单演示。
- **CI/本地工作流**：支持 commit check、需求验收、patrol、报告归档、JUnit/PR annotation 和 GitHub Actions。

## 面试中的一句话

> 我做了一个证据驱动的 AI 测试官：它不只生成测试用例，而是把需求和代码变更转成可执行的灰度计划，独立运行浏览器测试，并把失败归因和发布建议绑定到可复核证据上。

## Demo 场景

仓库内置一个任务管理应用和一条“已完成筛选”场景：

1. 输入任务筛选需求和一段 Git diff。
2. Agent 分析受影响的组件、接口和边界场景。
3. 生成 `smoke -> core_path -> edge_case -> regression` 灰度计划。
4. 用户确认浏览器控制和测试命令权限。
5. Agent 启动独立的 `app-under-test`，点击“已完成”，检查请求参数和页面 DOM。
6. 采集操作前后截图、network、console、DOM 和 trace。
7. 如果结果与需求不符，记录失败归因、证据引用和 `hold_for_review` 建议。

```text
Requirement + Git diff + target app
              |
              v
Context / impact analysis
              |
              v
Human-reviewed gray plan
              |
              v
Playwright execution + evidence capture
              |
              v
Failure attribution + layered Judge
              |
              v
CI gate / Workbench report / human decision
```

## 能力范围

| 模块 | 当前实现 | 说明 |
| --- | --- | --- |
| Context connectors | 已实现 | 本地文件、Git diff、GitHub PR diff、Issue/Jira/TAPD 类输入和 OpenAPI |
| 项目适配 | 已实现 | 识别本地项目、目标地址、启动/停止和连接诊断 |
| 计划生成 | 已实现 | 场景 DSL、风险列表、测试层级、oracle 和 evidence requirements |
| 浏览器执行 | 已实现 | Playwright、重试、操作事件、截图、trace、DOM/network/console 证据 |
| 失败归因 | 已实现 | 结合失败结果、变更引用和证据输出候选原因 |
| Judge | 已实现 | deterministic baseline + 可选 LLM assisted，多层报告和 schema 校验 |
| Workbench | 已实现 | 上下文、计划、Live View、Evidence、Judge、CI、连接器和权限面板 |
| CI gate | 已实现 | commit check、strict gate、JUnit、PR annotation 和报告 artifact |
| 长期巡检 | Demo 级 | patrol scheduler、趋势和报告保留策略已具备骨架 |

## 架构

```text
workbench-ui/              React + Vite operator workbench
        | HTTP + JSON
agent/src/server.ts        Express API and orchestration boundary
        |
        +-- sourceConnectors       requirement/diff/issue/OpenAPI inputs
        +-- intakeAnalyzer         context and impact analysis
        +-- plan/executablePlan    scenario DSL and gray plan
        +-- testRunner             Playwright execution
        +-- evidenceStore          run bundle and evidence records
        +-- failureAttribution     failure classification
        +-- llmJudge/judgeEngine   layered judgment and fallback
        +-- ciContract              release gate output
        |
app-under-test/             independent Vite/Node task application
fixtures/                   standalone target projects
data/scenarios/             executable scenarios and oracle fixtures
```

关键边界是：`app-under-test` 只提供被测业务和 API，Agent 负责规划、执行、取证和判断，Workbench 负责展示与人工控制。这样 Demo 的闭环不会把被测结果直接写死在 UI 中。

## 快速开始

环境要求：Node.js 20+、npm 10+，以及 Playwright Chromium 浏览器。

```bash
git clone <your-github-url>/ai-test-officer.git
cd ai-test-officer
npm ci
npx playwright install chromium

cp .env.example .env
set -a
source .env
set +a
npm run init:local-config
```

`init:local-config` 会在项目外的 `~/.ai-test-officer/master-key` 创建本地 master key，并从 `config/config.example.json` 生成未提交的 `config/local-secrets.json`。密钥不会写进 Git 仓库。

### 启动三个服务

推荐分别打开三个终端：

```bash
# Terminal 1: Agent API
npm run dev:agent

# Terminal 2: 独立被测应用 API + Web
npm run dev:app

# Terminal 3: VS Code 风格 Workbench
npm run dev:workbench
```

默认地址：

| 服务 | 地址 | 用途 |
| --- | --- | --- |
| Agent API | <http://localhost:4317> | 规划、执行、证据、Judge 和 CI API |
| App API | <http://localhost:6172> | 独立被测应用 mock API |
| App Web | <http://localhost:6173> | 被测任务管理页面 |
| Workbench | <http://localhost:6174> | 操作台 |

也可以使用 `npm run dev` 一次启动开发服务，结束后执行：

```bash
npm run stop:dev
```

## 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AGENT_API_TOKEN` | `dev-local-token` | Agent API 访问令牌；生产环境必须显式替换 |
| `HOST` | 本地模式为 `127.0.0.1` | Agent 监听地址 |
| `PORT` | `4317` | Agent API 端口 |
| `VITE_AGENT_API_URL` | `http://localhost:4317` | Workbench 连接的 Agent 地址 |
| `APP_API_HOST` | `127.0.0.1` | 被测 API 监听地址 |
| `APP_API_PORT` | `6172` | 被测 API 端口 |
| `APP_ALLOWED_ORIGINS` | localhost:6173 | 被测 API CORS 白名单 |
| `APP_URL` | `http://localhost:6173` | 测试执行目标 |
| `PROJECT_ID` | `local_demo_app` | 项目适配器使用的项目 ID |
| `SCENARIO_ID` | 空 | 需求验收或 CI 使用的场景 ID |
| `WORKSPACE_ROOT` | 当前项目根目录 | 本地 diff 和文件 connector 白名单根目录 |
| `AGENT_MASTER_KEY_FILE` | `~/.ai-test-officer/master-key` | credential 加密 key 路径 |

不要把 `AGENT_API_TOKEN`、LLM API key、`config/local-secrets.json`、`.master-key`、截图或 trace 提交到 GitHub。

## 常用命令

```bash
npm run typecheck             # 三个 workspace 的 TypeScript 检查
npm run build                 # Agent、被测应用和 Workbench 构建
npm test                      # Agent、app-under-test、Workbench 合同测试
npm run health:check          # 检查本地服务

npm run demo:verify           # connector -> 执行 -> Judge -> 报告的完整 demo
npm run requirement-acceptance
npm run commit-check          # 非严格发布检查
npm run commit-check:strict   # 严格 gate，适合 CI
npm run patrol                # 固定场景巡检
npm run judge:eval            # Judge 基准 case 评估

npm run reports:retention     # 只预览报告清理计划
npm run reports:retention:archive
```

`demo:verify` 会写入本地 `reports/`。该目录只用于运行时证据和调试，不作为源代码提交；需要给面试官展示时，建议通过 README 截图、脱敏后的单次 run bundle 或 GitHub Actions artifact 分享。

## Judge 与证据模型

系统将“判断”拆成三层：

- **Plan Judge**：测试计划是否覆盖需求、风险和必要 oracle。
- **Evidence Judge**：执行是否采集了足够证据，证据是否能支持断言。
- **Release Judge**：结合失败归因、风险等级、回归和 gate 配置，给出 `pass`、`hold_for_review` 或阻塞建议。

当 LLM provider 不可用、返回非法 JSON 或超时，系统可以回退到 deterministic baseline。报告必须展示 `executionMode`、`llmStatus`、`policyVersion` 和错误信息；fallback 不是“AI 已经判断成功”，而是“系统用可重复规则完成了降级判断”。

## 安全边界与当前限制

这个仓库是可运行的工程 Demo，不是假装成已经完成企业级安全的平台。当前需要在 README 和面试中主动说明：

1. 默认 token 只适合本机开发，部署前必须设置强 token、限制 CORS 和绑定受控 host。
2. connector 支持远程 URL 和本地文件，生产环境还应增加 SSRF 防护、内网/metadata 地址拒绝、超时和响应大小上限。
3. evidence 和 run bundle 目前包含 JSON/文件存储路径，单进程本地运行可用；多进程部署需要事务性数据库、run index 和并发锁。
4. credential 的加密 key 默认放在用户目录，仍应替换为系统 secret manager 或 CI secret store。
5. LLM 输入包含需求、diff 和运行证据，生产版需要做 prompt injection 分层、敏感信息脱敏和 provider 隔离。
6. 当前场景 DSL 和 oracle 已经可复用，但真实项目接入仍需要项目适配器、selector registry、测试数据治理和权限审批。

## 测试策略

- Agent tests：schema、connector、项目检测、权限、安全、run lock、evidence integrity、Judge、CI contract、报告归档和服务健康。
- App-under-test tests：API 和筛选场景的合同测试。
- Workbench tests：组件契约、状态和关键面板。
- Demo verification：启动独立被测应用和 fixture server，跑完整证据链并验证报告结构。

## 目录

```text
agent/             Express Agent、执行器、连接器、Judge、存储和测试
app-under-test/    独立任务管理被测应用
workbench-ui/      React/Vite 的 VS Code 风格操作台
data/              scenarios、judge cases、sample diffs 和项目适配配置
fixtures/          standalone target project fixture
docs/              架构、产品、CI、连接器、演示和安全说明
scripts/            本地配置、健康检查、服务停止和报告保留
config/             只提交 config.example.json；本地 secrets 被忽略
```

## 后续路线

- 把 evidence store、run history 和 latest-run pointer 迁移到事务性存储。
- 完成远程 connector 的 SSRF、域名白名单、响应大小和凭据隔离策略。
- 为 scenario、oracle、selector 和 artifact 建立版本化 schema 与 registry。
- 增加真实外部项目 onboarding，减少对固定 `task_filter_completed` fixture 的依赖。
- 将 LLM Judge 的输出与 deterministic 规则、人工 override 和历史误报率统一纳入评估。
- 增加 GitHub App/PR webhook、隔离执行沙箱和可观测性指标。

## 免责声明

AI Test Officer 的输出是质量辅助信息，不替代开发者、测试工程师或发布负责人的最终判断。任何自动 gate 都应允许人工复核、覆盖和追溯。
