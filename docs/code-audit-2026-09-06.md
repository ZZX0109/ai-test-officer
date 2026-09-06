**代码可行性与功能贯通审查 — 2026-09-06**

本报告记录 2026-09-06 对包含未提交改动的本地工作区所做的代码审查，不是某个 Git 提交、GitHub 发布版本或生产部署的验收证明。判断仅依据当时的源码、依赖与构建配置、测试代码和实际执行结果；审查时未阅读 README，也未使用项目自己的完成度报告作为证据。审查及方案制定未修改业务源码或原测试。

本次公开整理只发布审计结论与待实施方案，不表示缺陷已经修复。源码链接用于定位，行号对应审计时工作区，可能与仓库后续版本不同。审计时未跟踪的源码文件仅保留路径文本，不生成不可访问的 GitHub 链接。实施批次与真实验收条件见[修复与完善方案](remediation-plan.md)。

**总体判断**

项目的技术路线可行，而且已存在大量真实执行逻辑，能够支持继续开发和本地试用。但当前不能认定为完整可靠的通用测试平台，也不适合直接据此宣称生产闭环已完成。主要短板是跨模块状态与权限的一致性、生产配置和真实端到端验收，不是缺少模块数量。

**我从代码理解的项目用途**

这是面向开发、测试和验收人员的 AI 测试工作台。用户提供应用地址或本地项目，并补充需求、代码 diff、缺陷上下文；系统识别运行方式、组织业务功能与测试路径，让用户确认范围和权限，再驱动浏览器或结构化执行器执行检查。结果应该由可追溯的截图、DOM、网络、日志与断言支持。发现问题后，进入归因、环境恢复、人工决策或源码副本中的修复与回归验证。

例如“修改了任务筛选逻辑，确认筛选已完成任务没有破坏其他流程”：工作台应准备目标应用，定位受影响业务路径，执行点击与断言，保留前后截图和网络记录，给出通过、失败或阻塞的结论；必要时生成修复补丁并复测。

它还包含 CI 门禁、定时巡检、通知、基准评测、测试资产、历史记忆、运行轨迹等扩展能力。静态技术栈识别覆盖多类语言和框架，但识别出启动命令不能等同于这些项目都已在隔离环境中跑通。

| 环节 | 主要代码 | 本次判断 |
| --- | --- | --- |
| 工作台与项目接入 | workbench-ui、projectDetection、projectRegistry、projectAdapter | 实际实现；切项目请求存在状态串扰，容器写入路径不完整 |
| 需求与业务规划 | planningConversation、planningService、businessCapabilityGraph、businessFunctionCompiler | 实际实现；用户编辑后的范围与执行清单存在不一致 |
| 运行编排 | agent-orchestration、agentGraphService、runEventStore、runOrchestrator | LangGraph、事件状态机、父子任务、队列、租约和 Outbox 均有实现；长任务聚合失败收尾有缺口 |
| 实际测试执行 | browser-agent、testRunner、structuredActionExecutors、execution-worker | 有真实 Playwright 操作及 API/数据/任务/命令检查；默认测试不能证明任意外部项目运行成功 |
| 证据与判定 | evidenceStore、proof、proofGraph、judgeEngine、llmJudge | 有证据关联、完整性校验与机器规则；直接下载入口缺项目授权，新增统计指标有失真 |
| 修复与复测 | repairWorkspace、llmCodeRepair、RepairWorkspace 组件 | 源码副本、Diff、验证与应用均有实现；再次编辑未撤销旧验证，修复方案状态事件映射有误 |
| 正式部署 | Dockerfile.production、production-acceptance/compose.yml、security、auth | PostgreSQL/Redis/S3/OIDC 配置存在；实际 UI 登录、共享可写存储、OCI 执行通道尚未贯通 |

**实际验证结果**

| 检查 | 结果与限制 |
| --- | --- |
| npm run build | 通过：工作区包、Agent、示例应用、工作台均编译成功；Vite 有 bundle 大小警告，不阻断构建 |
| npm run lint | 通过 |
| npm run quality:contracts | 通过：扫描 370 个源码文件，未发现该检查禁止的显式 any/z.any |
| npm run size-guard | 失败：agent/src/server.ts 为 2064 行，超过通用 2000 行门禁，未列入该门禁实际 allowlist |
| npm test | 命令退出码为 0，但后端测试提前退出，不能记为整套通过；前端 Vitest 5 个文件、53 个测试通过，各独立 package 测试命令通过 |
| 后端执行进度核验 | 在临时目录生成只增加前后日志的临时副本，前 5 个测试完成，第 6 个 testLlmProviderChatAndAnthropicStreaming 尚未完成就触发 beforeExit，退出码仍为 0；后续 102 个入口未到达 |
| 后端补充执行 | 临时副本明确跳过上述 1 个悬挂测试，并用顶层 await 运行：其余 107 个测试入口和最终 selfTest 均执行返回；其中 4 个可选环境用例受原代码开关控制，默认跳过 |
| 悬挂用例单独验证 | 在临时目录的测试副本中仅为取消 mock 补上 signal.aborted 的即时拒绝，保留其他断言，顶层 await 执行后明确完成、退出码 0；包含 llm_cancelled 与只请求一次的断言。这进一步定位为测试替身与入口问题 |
| 定向复现 | 真实前端函数/Hook + 内存响应复现了范围编辑丢失和项目切换串扰；真实指标函数复现了无断言仍显示 100% 准确率；修复状态机非法转换有纯函数复现 |

未执行真实模型服务端到端工作台验收，也未启动完整 Docker/PostgreSQL/Redis/MinIO/OIDC 生产栈。外部项目 smoke、OCI 静态项目 smoke、投资工作流 smoke、PostgreSQL 重启验证均有环境开关，默认测试成功不能证明它们完成。

环境默认 Node 为 20，仓库包装脚本实际选用了已安装的 Node 24.13.0，满足本项目的声明要求。首次测试被执行沙箱的本地 IPC/端口权限阻断；获准在沙箱外重跑后不再出现此问题，这不计入项目缺陷。

**优先修复的问题**

**1. P1：测试套件会“假绿”，掩盖后端未执行的检查。已复现。**

位置：[llmProvider.test.ts:344](../agent/tests/llmProvider.test.ts#L344)、[runTests.ts:220](../agent/tests/runTests.ts#L220)。

取消测试的 mock fetch 只监听将来的 abort 事件，没有处理已经 aborted 的 signal。模型调用开始前会等待同 Provider 的调用间隔，5 ms 的取消可以先发生，导致 mock 永不结束。测试入口仅调用 main().catch，没有顶层 await 和完成性检查；挂起 Promise 不维持 Node 事件循环，进程会成功退出。

影响：当前 npm test 的成功状态无法证明后端回归完整。不能把这一现象归因于真实原生 fetch；问题是测试替身和入口共同制造的假通过。

建议：修正 mock 对预取消的处理，等待 fetch 注册完成再主动取消；入口采用顶层 await 或标准测试运行器，并加入单测试超时及完成计数。

**2. P1：用户确认的测试范围没有成为实际执行的唯一依据。已复现。**

位置：[usePlanningFlowEdits.ts:23](../workbench-ui/src/hooks/usePlanningFlowEdits.ts#L23)、[useAutomaticPlanning.ts:64](../workbench-ui/src/hooks/useAutomaticPlanning.ts#L64)。

排除和新增流程只修改 businessFlows，执行阶段却优先遍历 businessFunctions.pathIds。只要业务功能摘要非空，删除路径可能重新进入执行，新增路径被丢弃。

复现：界面清单为 [kept, manual_added]，功能摘要仍为 [kept, excluded_by_user]；实际生成的 coverageInventory 为 [kept, excluded_by_user]。

建议：将用户确认后的清单保存为不可变运行快照，所有展示、功能摘要和执行编译均使用同一份数据；回归测试覆盖删除、新增和改名后的请求体。

**3. P1：生产 OIDC 身份链路存在三个独立断点。代码与请求复现确认。**

位置：[useWorkbenchLifecycleEffects.ts:101](../workbench-ui/src/hooks/useWorkbenchLifecycleEffects.ts#L101)、[OidcSessionPanel.tsx:1](../workbench-ui/src/components/OidcSessionPanel.tsx#L1)、[api.ts:1111](../workbench-ui/src/api.ts#L1111)、[api.ts:1702](../workbench-ui/src/api.ts#L1702)。

配置 OIDC 但未登录时初始化直接返回，而包含登录按钮的 OidcSessionPanel 没有挂载到实际界面。即使已有 token，创建运行仍硬编码 organizationId=local，真实组织的非 admin runner 会被后端组织检查拒绝。事件/轨迹流与附件下载没有使用普通 API 已有的 authenticatedHeaders，因此不携带 Bearer token，生产认证下会返回 401。

建议：接通实际登录入口，从已验证会话取得组织，统一所有普通请求、SSE 和二进制下载的认证方式；以非 admin 的真实组织用户验收全过程。

**4. P1：直接证据下载入口缺少组织和项目授权。代码确认。**

位置：[server.ts:426](../agent/src/server.ts#L426)、[security.ts:218](../agent/src/security.ts#L218)。

/artifacts/* 检查 JWT 有效和路径未逃出 reports 后便 sendFile，没有检查该文件属于哪个 Run、组织或项目。有效登录身份加上已知文件路径，就能绕过上层列表接口的项目权限。这个入口还覆盖 reports 下的非证据文件。

建议：下载按 artifactId 查记录，验证 Run/组织/项目的 read_artifacts 权限后再解析存储路径；避免把整个 reports 目录当作下载命名空间。

**5. P1：复测通过后再次编辑，旧验证仍能批准新补丁。代码闭环确认。**

位置：[repairWorkspace.ts:447](../agent/src/repairWorkspace.ts#L447)、[repairWorkspace.ts:1129](../agent/src/repairWorkspace.ts#L1129)、[RepairWorkspace.tsx:487](../workbench-ui/src/components/RepairWorkspace.tsx#L487)。

文件保存仅将 session.status 改为 editing，保留 validation.status=passed 与 mergeEligibility。应用接口和按钮只判断旧的 passed；原项目摘要检查无法证明当前补丁就是被验证过的版本。

触发：验证通过 → 再编辑保存 → 在开启 REPAIR_HOST_APPLY_ENABLED=true 的部署中应用。

建议：所有修改立即撤销验证，验证记录绑定当前补丁/沙盒树摘要，应用时原子校验摘要及状态。默认关闭 host apply 限制了源码写回影响，但旧验证展示本身仍有问题。

**6. P1：提供的容器配置不能支撑完整接入和修复流程。配置与代码确认，未启动生产栈。**

位置：[compose.yml:165](../deploy/production-acceptance/compose.yml#L165)、[projectRegistry.ts:176](../agent/src/projectRegistry.ts#L176)、[credentialStore.ts:9](../agent/src/credentialStore.ts#L9)、[Dockerfile.production:1](../Dockerfile.production#L1)。

API/worker 根文件系统只读，仅 reports 共享可写。但创建/修改项目写容器工作目录的 data/projects，凭据写容器工作目录的 config，主密钥写用户 home；这些位置没有配套可写持久卷，也没有迁移至 PostgreSQL，新建项目和配置模型将遇到只读文件系统错误。

外部项目 OCI 启动和修复验证直接调用 docker，而当前镜像构建和 compose 没有配置完整 Docker CLI/daemon 通道。对预启动 HTTP fixture 的生产验收不能替代任意项目的接入、启动和修复验证。

建议：明确控制面与执行面的存储和运行边界，为项目/凭据提供共享持久化，配置受控执行服务；从空环境完成一次新项目接入验收。

**7. P2：快速切项目会使界面混入旧项目状态。已复现。**

位置：[useProjectSelection.ts:97](../workbench-ui/src/hooks/useProjectSelection.ts#L97)、[useConfirmedScenarioExecution.ts:124](../workbench-ui/src/hooks/useConfirmedScenarioExecution.ts#L124)。

旧 detect/runtime/grants 请求返回后，没有统一检查当前 projectId/requestId 就写 React state。复现 A→B、A 后返回后：selectedProjectId 和 draftId 为 B，appUrl 与 detection 却为 A。运行完成后的旧回调也可能覆盖当前结果。后端受管运行地址有额外解析保护，因此不能据此断言每次都会真的测试错项目；界面配置和结果串扰已证实。

建议：切项目取消旧请求，所有异步提交核对项目与请求身份，统一使用已有 reducer 的版本保护。

**8. P2：测试质量指标把缺失观测变成了好看的数值。已复现。**

位置：`agent/src/qualityMetrics.ts:32`（审计时未跟踪文件）、`agent/src/qualityMetrics.ts:56`（审计时未跟踪文件）、[browserExecutionProof.ts:300](../agent/src/graph/browserExecutionProof.ts#L300)。

precision/recall/F1 实际均由执行通过率推导，未使用标注真值；无误报/漏报样本时填 0。证据覆盖只需有一个 evidenceRef 就把该路径所有证据类型算作满足。flaky、环境失败率和平均耗时也固定为 0。

真实函数复现：路径未执行、断言数为 0，仅有一个未分类证据引用，输出 evidenceCoverage=1、precision=recall=f1Score=1，而 requirementCoverage=oracleCoverage=0。

这证明统计展示不可信，不代表确定性机器门禁也会放行。建议将无数据标为未知，逐路径、逐断言、逐证据类型计算覆盖；准确率指标必须来自独立标注。

**9. P2：修复方案状态更新发生非法状态转换和部分提交。已复现状态机。**

位置：[repair.routes.ts:102](../agent/src/server/routes/repair.routes.ts#L102)、[contracts/index.ts:148](../packages/contracts/src/index.ts#L148)。

路由先写方案状态，再将 applied/resolved 等变化映射成 plan_approved。该事件只允许用于 awaiting-plan-approval；正常修复场景的 failed、blocked、judging 均抛 Invalid run transition。结果是接口报错，但方案状态已更改，审计未完成。

建议使用不推动运行状态的专用修复方案事件，并将状态和审计作为一次事务提交。

**10. P1：Redis 父任务聚合重试耗尽后没有最终收尾。代码控制流确认，未做 Redis 故障注入。**

位置：[runOrchestrator.ts:539](../agent/src/runOrchestrator.ts#L539)、[runOrchestrator.ts:836](../agent/src/runOrchestrator.ts#L836)、[runOrchestrator.ts:869](../agent/src/runOrchestrator.ts#L869)。

子任务未结束时聚合抛 child_runs_pending；Redis Job 默认重试 1200 次，耗尽后没有同步终结父 Run 的处理。非 Redis 分支的超时处理不会在此执行，父执行租约已释放。长路径或较久的人工等待可能留下永久 running 的父任务，后续子任务完成也没有新的聚合触发。

建议为父聚合增加持久化截止时间、终止/恢复状态与子任务终态触发，并测试重试耗尽及重启。

**11. P2：当前质量门禁和 CI 尚不能干净通过。实测和配置确认。**

位置：[file-size-guard.mjs:27](../scripts/file-size-guard.mjs#L27)、[ai-test-officer.yml:68](../.github/workflows/ai-test-officer.yml#L68)、[workbench-e2e.mjs:71](../scripts/workbench-e2e.mjs#L71)。

size-guard 已实测失败。除此之外，工作台 E2E 强制要求默认模型凭据并执行真实模型演示，但普通 GitHub workflow 没有创建该凭据的步骤；仓库示例凭据为空，真实配置被 git 忽略。因此在干净 CI 中，即使修复 size-guard，也不能假定 E2E 会成功。

建议先恢复可信的默认回归门禁，再分别提供可重复的离线集成测试和明确配置真实凭据的模型验收。

**其他已定位的边界问题（静态确认）**

- [server.ts:479](../agent/src/server.ts#L479)：repair router 先注册，maintainer/admin 角色中间件在其后，相关角色限制不会执行；项目 scope 检查仍存在，不能描述成完全无鉴权。
- [execution-worker/index.ts:187](../packages/execution-worker/src/index.ts#L187)：命令超时只发 SIGTERM，没有强制终止升级或独立超时结果；不响应 SIGTERM 的进程可能使等待不结束。本次未执行对抗进程试验。
- [projectAdapter.ts:696](../agent/src/projectAdapter.ts#L696)：启动时预安装 node_modules 绑定未指定只读，执行器默认可写；在宿主文件权限允许的情况下可能污染原项目依赖。
- [desktopCaptureAdapter.ts:10](../agent/src/desktopCaptureAdapter.ts#L10)：原生截图通路接受调用者传入的应用 allowlist 和审批字符串，原生 helper 又仅按 windowId 捕获；应验证真实审批及窗口归属。仅在启用 helper 和系统权限时相关，本次未执行桌面捕获。

**建议修复顺序与验收标准**

1. 先修测试入口，让失败、挂起和跳过可见，恢复 size-guard 与干净 CI。
2. 修范围编辑、项目切换和补丁验证失效，确保“用户确认的东西”就是“实际执行/应用的东西”。
3. 接通 OIDC、组织信息、SSE/下载鉴权，并堵住直接证据下载越权。
4. 从空配置启动提供的容器方案，走完“登录→接入新项目→配置凭据→启动→规划→确认→执行→下载证据”。
5. 对失败项目完成“生成补丁→验证→再次编辑使旧验证失效→重新验证→应用或导出”，再补长任务、取消及重启验收。
6. 校正统计口径；暂时不能测量的指标明确显示未知。

当以上主流程有可重复的真实端到端记录后，才适合把定位从“可运行的测试工作台原型”提高到“可靠的通用测试平台”。

**原始日志与可复验范围**

构建、Lint、源码契约、size-guard、默认测试、后端逐项进度和补跑的原始日志保留于审查者本地，未随本次文档发布。临时测试副本及临时复现脚本同样未发布。因此表中的执行结果是带日期和限制的审计记录，不能作为读者已获得完整发布验收证据包的证明。

后续修复应在可标识的提交上重新执行，公开脱敏后的检查清单、实际完成计数、环境与版本摘要、失败和阻塞原因，以及真实端到端验收证据；不能用本报告替代这些结果。
