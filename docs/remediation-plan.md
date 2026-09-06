**AI Test Officer 修复与完善实施方案**

基于 2026-09-06 对包含未提交改动的本地工作区所做的[代码审查](code-audit-2026-09-06.md)制定。本文件是待实施方案；本次文档发布未实施下列修复，不代表某个 Git 提交、GitHub 发布版本或生产部署已经通过验收。方案制定期间未修改业务源码，也未运行真实模型或外部业务操作。此前审查未读取 README；此事实不限制后续文档维护。

源码链接用于定位，行号对应审计时工作区，可能与仓库后续版本不同。审计时未跟踪的源码文件仅保留路径文本。原始本地日志和临时复现脚本未随文档发布，公开结论与完整发布验收证据包应明确区分。

**交付目标和完成规则**

交付一个能从空环境接入真实应用、执行用户确认的测试、产出可核验结论，并通过真实复测交付修复的工作台。保留现有 React、Express、LangGraph、Playwright、PostgreSQL、BullMQ 和对象存储实现，修通现有边界。

所有产品完成声明和发布验收必须满足以下规则：

- 真实源码、构建、进程、浏览器、接口和数据服务参与运行；不得使用预录成功、空实现、固定返回值代替功能。
- 声称 AI 规划、AI 浏览器决策、AI 判定或 AI 修复时，对应阶段必须有本次真实 Provider 调用和实际消费其输出的记录；一次凭据探测不能替代全流程调用。
- 缺模型凭据、数据库、运行环境或权限时返回明确的 blocked/not-configured；不得转入演示数据后显示成功。
- 纯函数检查可继续直接调用真实函数。HTTP 取消/超时用真实本地 HTTP 服务和实际网络栈验证，但该测试只能证明传输语义，不能计为真实模型能力验收。
- 示例应用仅证明其对应功能。通用项目能力必须在锁定版本的外部项目中验证；技术栈识别结果不能等同于运行通过。
- 验收必需项为 0 执行、跳过、blocked 或证据缺失时，发布验收不得通过。明确显示哪些检查完成、哪些未完成，不把环境缺失误报成产品缺陷。

**需要先撤销的现有完成证明**

除前次报告的测试提前退出外，继续查看验收脚本发现：

- [external-evaluator.mjs:81](../scripts/external-evaluator.mjs#L81) 基本沿用 Agent 的 gateStatus，并在执行后生成匿名标签，没有独立判断业务正确性的真值。
- [external-differential-evaluator.mjs:23](../scripts/external-differential-evaluator.mjs#L23) 检查字段、hash 格式、终态和引用，不能独立证明差分分类正确。
- [external-repair-evidence.mjs:214](../scripts/external-repair-evidence.mjs#L214) 通过追加无关注释证明编辑；[该脚本:268](../scripts/external-repair-evidence.mjs#L268) 还存在跳过一批测试的分支，不能证明修复能力。

将这些结果明确标注为历史接口/结构检查，移出“缺陷识别准确率”“真实修复成功率”的数据源。禁止原地改写历史证据为新结果；修复后重新执行，生成有新版本号的新验收记录。

**建议实施批次**

| 批次 | 产物 | 依赖 | 结束条件 |
| --- | --- | --- | --- |
| A | 可信测试入口、完整检查清单、清理虚假验收口径 | 无 | 挂起/漏执行能使检查失败，全部必需项可计数 |
| B | 版本化确认计划、前端异步状态隔离 | A | 界面确认、API 保存和实际执行的范围完全一致 |
| C | 完整会话身份与证据授权 | A；与 B 并行 | 真实普通用户登录、执行、看证据成功；越权失败 |
| D | 生产共享持久化和实际执行节点 | A；与 B/C 部分并行 | 新项目从空配置接入、启动，API/worker 重启后状态可用 |
| E | 跨进程取消、父子任务收尾和恢复 | B、D | 实际资源停止，长任务和重启均有确定结果 |
| F | 与补丁版本绑定的修复复测 | B、C、D、E | 原缺陷失败→修复通过→撤销修复再次失败；旧验证不可复用 |
| G | 独立业务评估、真实指标与端到端发布门禁 | A–F | 真实项目正反对照和完整证据全部完成 |
| H | 外围能力与支持矩阵收口 | 共用 C–G | 每个对外开放能力有真实验证记录，未配置状态准确 |

每批提交包括业务代码、契约/迁移、真实检查和对应证据。模块重构随该批缺陷修复进行，不通过放宽门禁或扩大白名单消除失败。

**A. 先恢复可信的测试和验收入口**

主要文件：[runTests.ts](../agent/tests/runTests.ts)、[llmProvider.test.ts](../agent/tests/llmProvider.test.ts)、[package.json](../package.json)、[file-size-guard.mjs](../scripts/file-size-guard.mjs)、[CI workflow](../.github/workflows/ai-test-officer.yml)。

实现：

- 后端入口改为顶层 await，并以标准测试运行器逐项登记、等待和输出结果；为每个异步测试设置真正计时的超时保护。
- 通过自动发现或显式测试清单记录 expected/started/completed/failed/skipped/blocked；不再通过最后一个 console.log 推断全部完成。
- 将问题取消用例改为实际 HTTP 连接：服务端确认请求已收到后取消客户端，确认请求关闭且不会重试；再单测发送前已取消的情况。服务和测试有独立关闭期限。
- 单元逻辑、真实服务集成和真实模型验收分别输出报告；发布检查显式运行所有必需组，不能由环境变量悄悄跳过。
- 从 server.ts 移出相关路由装配/服务初始化，并保持中间件次序，实际恢复 size-guard，不修改行数阈值。
- 对现有允许 incomplete、缺少证据时 skip 的审计分支做发布模式限制：本地诊断可输出未完成报告，发布 job 必须失败。

真实验收：人为制造一次断言失败、一次悬挂、一次缺失必需服务；三个情况都必须退出非零且指出未完成项。正常环境所有必需项均显示完成；原始源码测试不再依赖临时副本跳过。

**B. 让确认计划成为实际执行依据，并修复前端状态串扰**

主要文件：[planningInventoryStore.ts](../agent/src/planningInventoryStore.ts)、[planningService.ts](../agent/src/planningService.ts)、[usePlanningFlowEdits.ts](../workbench-ui/src/hooks/usePlanningFlowEdits.ts)、[useAutomaticPlanning.ts](../workbench-ui/src/hooks/useAutomaticPlanning.ts)、[useProjectSelection.ts](../workbench-ui/src/hooks/useProjectSelection.ts)、[workspaceReducer.ts](../workbench-ui/src/state/workspaceReducer.ts)。

在已有 PlanningInventory 上增加正式版本和确认快照。以下字段是建议新增/完善的契约，不是当前已有接口：

| 数据 | 必需内容 | 约束 |
| --- | --- | --- |
| 计划草稿 | organizationId、projectId、inventoryId、revision、sourceSnapshotHash、路径与断言要求 | 编辑使用 expectedRevision；不能跨项目修改 |
| 确认快照 | planSnapshotId、planHash、revision、确认主体与时间、包含路径、排除路径与原因、前置条件、权限、数据/环境引用 | 确认后不可覆盖；修改生成新版本 |
| Run 绑定 | planSnapshotId、planHash、源码/manifest 版本、实际 Attempt 与 runtimeBinding | 服务端从快照编译，不信任客户端重建执行清单 |

实现：

- businessFlows/path inventory 作为唯一可编辑事实；业务功能摘要、分组、计数和报告由它派生，不再保留独立可变 pathIds。
- 用户删除路径保留明确 excluded 记录，新增路径先补齐可执行动作和预期结果；不能执行的必需路径仍占据覆盖清单并阻止全通过，不静默丢弃。
- 确认动作原子保存计划快照并创建/绑定 Run，服务端校验版本、组织、项目、权限；重复提交用幂等键返回同一结果。
- 完整清单保存在后端。分页展示只影响 UI，不改变全量计划；确认时不可仅提交当前可见页。
- 统一 projectId + projectRevision + requestId 身份检查。检测、运行状态、权限、历史、规划、错误和 finally 分支都必须核对后再更新当前视图。
- 项目切换取消旧查询和订阅；已启动的后台 Run 继续按自己的 projectId 保存，不能因视图切换被无意取消或覆盖。查看历史运行时使用该运行自己的快照与目标。
- OpenAPI、生成的前端类型和 Python 客户端随 contracts 同步更新，移除兼容接口中再次推导范围的逻辑。

真实验收：在实际工作台规划 3 条路径，删 1 条、加 1 条并补齐预期，确认后查数据库快照、队列 payload 和实际浏览器轨迹；它们必须是同一组路径。快速 A→B→A 切换、刷新和后台运行完成后，项目地址、报告和权限均不串线。过期版本提交返回可解释的冲突。

**C. 接通真实身份，并统一所有资源授权**

主要文件：[auth.ts](../workbench-ui/src/auth.ts)、[api.ts](../workbench-ui/src/api.ts)、[security.ts](../agent/src/security.ts)、[run-repair-session.routes.ts](../agent/src/server/routes/run-repair-session.routes.ts)、[projectAccess.ts](../agent/src/projectAccess.ts)。

实现：

- 挂载实际 OIDC 登录、未登录和会话过期界面，走真实授权码流程。增加服务端会话信息读取，返回已验证的 subject、organizationId、角色和可访问项目。
- 普通请求、SSE、截图/文件下载和共享浏览器通路使用同一认证策略。会话过期触发重新登录或明确失败，不能继续使用默认开发 token。
- Run、子 Run、修复验证、测试资产验证、巡检等所有生产创建入口都继承已授权组织，清理各处 organizationId=local；服务端验证，不依赖客户端自述。
- 角色与项目 scope 的检查直接放入路由或在路由之前注册。普通 runner 只获取获准使用的凭据摘要，不能为了通过 readiness 被迫成为 admin 或列出全部凭据。
- 验收分配实际职责：组织管理员初始化组织和模型凭据，项目负责人接入项目并授权，runner 执行授权项目，viewer 仅查看证据，maintainer/具备相应项目权限的人员处理修复。不能用一个全局 admin 账号掩盖普通角色流程不通。
- 使用 artifactId 下载：从记录解析所属组织、项目、Run 和对象位置，授权后读取真实文件或对象。旧 URL 通过已登记对象映射兼容，没有归属的路径不得直接放行。
- 所有证据、补丁、运行归档和内部目录采用同一规则。生产中去除 loopback 作为资源访问的授权替代。
- 原生桌面截图若开放，审批事件必须持久化并绑定用户、应用、窗口、用途与有效期；helper 再次核对实际窗口归属，不能接受任意审批字符串或客户端自定 allowlist。

真实验收：Keycloak 中建立两个组织的真实用户，以及 viewer/runner/maintainer 等角色，实际浏览器登录。验证普通用户能完成获准运行、SSE 重连、截图和报告下载；另组织用户即使知道 artifactId/旧路径也不能读取。令 token 失效后相关通路一致拒绝。所有拒绝均不产生对应修改。

**D. 补齐共享状态和真实项目执行环境**

主要文件：[projectRegistry.ts](../agent/src/projectRegistry.ts)、[credentialStore.ts](../agent/src/credentialStore.ts)、[projectLoginStore.ts](../agent/src/projectLoginStore.ts)、[projectRuntime.service.ts](../agent/src/server/services/projectRuntime.service.ts)、[projectAdapter.ts](../agent/src/projectAdapter.ts)、[execution-worker](../packages/execution-worker/src/index.ts)、[production compose](../deploy/production-acceptance/compose.yml)。

推荐使用现有 PostgreSQL 作为生产业务状态源，BullMQ 负责交付任务，MinIO/S3 保存可下载产物，专用 Linux 执行节点负责真实浏览器和 OCI。API 不直接运行目标项目，也不持有 Docker socket。执行节点初版直接运行 worker，避免工作节点容器路径、localhost 与 Docker daemon 所在主机不一致；后续容器化必须单独验证同一路径映射和网络可达性。

| 状态或资源 | 推荐位置 | 实施要求 |
| --- | --- | --- |
| 项目配置、manifest、版本与组织归属 | 扩展已有 projects_v1 | API/worker 读取相同版本；生产数据库故障不降级到本地空文件 |
| 模型/登录/目标服务凭据 | PG 中加密记录及版本 | 主密钥由部署 secret 只读提供并带 keyId；生产缺密钥启动失败，禁止临时生成新密钥 |
| 计划、Run、Attempt、权限、修复元数据 | 已有 PG 表扩展 | 事务与版本检查；进程内 Map 仅作缓存 |
| 运行/验证工作空间 | 执行节点独立目录或卷 | 每次运行独立、明确归属和清理；源码快照与编辑副本分开 |
| 截图、trace、日志、补丁和归档 | 对象存储 + 数据库索引 | 字节哈希和对象存在性验证；API 授权后提供下载 |
| Runtime 状态 | PG 中的 worker/runtime/attempt 绑定 | 保存真实 container/process id、内部地址、健康状态、租约、终止状态 |

实现：

- 增加迁移工具，导入原项目和加密凭据并检查数量、归属、解密可用性及配置版本；备份和验证完成前保留原文件。生产模式显式选择 PG，禁止双数据源静默兜底。
- 项目创建与负责人授权同事务提交；默认模型凭据按组织唯一。原文件组织归属无法确认时要求明确映射，不能把所有旧记录自动归入 local。
- 将项目准备/启动/停止、浏览器探索、修复验证和动态 Graph 节点中的实际执行 I/O 派发到 worker，API 返回可查询的持久任务。Graph 检查点保留，执行动作带执行代次，避免重放非幂等动作。
- 任务引用源快照，worker 拉取锁定 Git commit 或接入流程生成的源包并校验哈希；API 所见本机路径不能被当作远端 worker 同样可见。
- 目标容器只读挂载源快照，使用独立工作空间；依赖在受控构建阶段安装，缓存按锁文件、平台和镜像摘要隔离，不绑定原项目可写 node_modules。
- 浏览器与待测应用使用实际可达的 runtimeBinding 地址。建立 worker 浏览器会话到 API 的受认证帧/输入通路，工作台不能自行拼 localhost 目标。
- 数据库、队列、认证、迁移和初始化作为可检查的前置条件；每次验收使用独立数据库/测试账号和带 Run 标记的数据，完成后回收。
- 报告/修复元数据的数据库提交与文件/对象写入明确分阶段：先落可校验对象，再事务提交引用及事件；中断留下的孤儿对象由已有 reconciliation 清理。重启恢复不能读取一个新数据库记录配一个旧 session.json。
- 模型密钥只用于控制面/worker 的模型调用；目标项目只接收其获准的目标服务凭据，不能继承整个 Agent 环境。

真实验收：从新数据库、空项目列表和无历史运行的部署开始，通过界面接入外部项目、配置凭据、安装、启动并完成业务操作。随后重启 API 和 worker，项目、凭据、计划、报告仍可读取；数据库停机时明确失败。检查目标容器和宿主原项目文件无不应发生的修改。

**E. 让取消、超时、父子任务和恢复真正结束实际工作**

主要文件：[runOrchestrator.ts](../agent/src/runOrchestrator.ts)、[run-control.routes.ts](../agent/src/server/routes/run-control.routes.ts)、[executionLease.ts](../agent/src/executionLease.ts)、[execution-worker](../packages/execution-worker/src/index.ts)、[sessionManager.ts](../agent/src/browser-agent/sessionManager.ts)。

实现：

- 取消/暂停意图持久化，通知负责该 Attempt 的 worker，并由数据库轮询兜底；API 进程的本地 AbortController Map 不作为跨进程控制的依据。
- 区分已请求取消与已停止；真实模型请求、Playwright、目标进程、OCI 容器和子任务完成清理后记录终态与清理回执。清理失败必须可见并交由回收任务处理。
- 对进程设置优雅终止期限和强制结束期限；对容器按受管 id 停止、检查退出并回收；取消调用本身也必须有界。
- 父聚合使用 PG 持久截止时间和待完成子任务集合。子任务终态经 Outbox 触发聚合，周期扫描兜底。BullMQ 重试耗尽后产生可处理事件，不能只留下 failed Job 和 running Run。
- 人工等待设独立状态与过期策略，展示等待原因；到期写入明确 blocked/review 结果，不伪装执行成功。
- 重启/租约恢复校验 executionGeneration，旧 worker 的迟到结果不能覆盖新 Attempt。对已经提交的外部写操作先核验回执或实际状态；无法确认时进入人工处理，不盲目重复请求。

真实验收：API 与 worker 分开运行，实际开始浏览器操作后取消，检查目标应用收到的后续请求数不再增长，相关容器/会话退出；暂停恢复不得重复已确认的业务写入。运行途中终止 worker 再重启，验证恢复或明确阻塞。缩短测试环境的聚合预算，让真实子任务超时，父 Run 必须在预定期限内收敛。故障试验仅作用于本次专用测试进程和容器。

**F. 建立不可复用旧验证的真实修复流程**

主要文件：[repairWorkspace.ts](../agent/src/repairWorkspace.ts)、[llmCodeRepair.ts](../agent/src/llmCodeRepair.ts)、[planning-graph.ts](../packages/contracts/src/planning-graph.ts)、[repair.routes.ts](../agent/src/server/routes/repair.routes.ts)、[RepairWorkspace.tsx](../workbench-ui/src/components/RepairWorkspace.tsx)。

建议为验证记录补充：sessionRevision、sourceSnapshotHash、patchedTreeHash、patchSha256、validationSpecHash、dependencyLockHash、runtimeImageDigest、dataSnapshotRef、childRunIds。保留历史验证记录；新增修改只撤销其对当前版本的批准效力。

实现：

- 手工保存、AI 修改、导入补丁、依赖/命令/测试清单改变等所有入口增加版本并使当前验证失效；验证运行针对不可变副本，不能一边验证一边改同一目录。
- UI 的可应用状态来自服务端当前版本的 eligibility，应用时再次锁定版本、源项目摘要、补丁摘要、验证规格和操作者权限，避免检查后又被修改。
- 修复方案状态变化使用专用 repair_plan_status_changed 类型或已有等价的非状态迁移事件；方案记录和审计在同一事务写入，不能映射成 plan_approved。
- 用原始缺陷的独立断言复测，保留同一需求、计划、数据、环境和测试清单；补丁不能通过移除断言、加入 skip 或忽略失败改变通过标准。
- 如果原测试自身有问题，进入显式“测试资产修正”流程，由独立判据重新验证；不能同时把修改过的测试作为产品修复成功的唯一证明。
- 导出产物只能使用被验证的不可变快照。正式交付的补丁哈希必须与验证记录一致；未验证补丁可以作为草稿导出，但必须明确标记，不能宣称可合并。
- 本地源码应用保留当前显式操作入口；共享部署优先交付带验证证据的补丁/分支。实际写回后检查目标摘要和工作区，写回失败保留恢复信息，不掩盖部分应用。

每个真实修复案例必须完整执行以下顺序：

1. 在真实应用的缺陷版本上重现问题，独立业务断言失败，保存请求、数据库状态和浏览器证据。
2. 将失败证据交给真实模型生成补丁，保存本次模型调用与修改记录。
3. 对补丁副本进行实际构建、定向复测、相关模块检查和既定回归；同一缺陷断言转为通过，既定正确流程仍通过。
4. 在独立副本撤销该补丁并恢复同样的数据/环境，原断言必须再次失败；只在测试环境做这一对照。
5. 对已通过版本再次编辑一个文件，旧验证必须立即失效，后端拒绝直接应用；重新验证后才可交付。

不能将“追加注释”“文件写入成功”“补丁已导出”计作修复成功。

**G. 独立评估业务正确性，重算指标，落实发布门禁**

主要文件：`agent/src/qualityMetrics.ts`（审计时未跟踪文件）、[monitoring.ts](../packages/contracts/src/monitoring.ts)、[browserExecutionProof.ts](../agent/src/graph/browserExecutionProof.ts)、[external-evaluator.mjs](../scripts/external-evaluator.mjs)、[external-repair-evidence.mjs](../scripts/external-repair-evidence.mjs)、[acceptance-projects.lock.json](../acceptance-projects.lock.json)。

实现：

- 把现有字段/哈希格式检查保留为结构检查；新的评估过程实际下载证据对象计算哈希，读取测试应用的独立业务结果，与预先锁定的正确/缺陷案例真值比较。
- 真值在运行前固定，记录数据集版本和哈希。评估进程持有标签及独立检查，Agent/worker 看不到答案；不能事后按 Agent 结论生成真值。
- 对每项业务检查保存 requirement→path→action→oracle→evidence→artifact 的对应关系，按 Run/Attempt/计划版本验证，不能让一张截图满足所有路径的证据要求。
- 计算清楚的统计口径：需求覆盖率基于确认后必需路径；断言覆盖基于唯一断言 id；证据覆盖逐路径逐类型核验；空分母显示未知或不适用，不自动记 100%。
- 准确率使用独立标注混淆矩阵：TP=正确报告缺陷，FP=误报健康案例，FN=漏检缺陷，TN=正确通过健康案例；precision=TP/(TP+FP)，recall=TP/(TP+FN)。blocked/待人工另列未决，额外报告全部缺陷案例的发现比例，避免只在已作答样本上掩盖拒答。
- 单独显示错误放行比例、误报比例、未决比例、样本量、数据集版本和原始案例；不能用业务测试通过率替代缺陷识别准确率。
- flaky 必须来自同源码/数据/环境的重复运行；实际耗时来自时间记录；未测得数据为 null/unknown。同步调整 contracts、前端、报告和历史数据迁移；旧指标保留旧版本，不混算。
- 模型驱动案例的证据要求匹配其实际阶段：规划有真实调用和被采用的输出，浏览器决策有被执行的动作，Judge 有引用本次证据的结论，修复有生成及验证的补丁。缺少任一所声称阶段就不能把该阶段标为完成。

真实项目使用仓库现有锁定清单，先验证当前版本实际可用性：

| 项目 | 验证用途 | 完成要求 |
| --- | --- | --- |
| full-stack-fastapi-template | 登录、CRUD、权限、真实 PostgreSQL 数据 | 冷启动、真实页面/接口/数据库一致；正确与缺陷版本对照 |
| ANDFlow | 较复杂页面、导航、状态及跨页面流程 | 补齐其实际依赖后完成选定业务路径；外部服务不能替换为固定成功 |
| spring-petclinic | Java 构建、表单/校验、持久化和回归 | 原生构建/测试与浏览器业务检查一致，至少一项真实缺陷修复 |
| nextjs-with-docker | Next.js 构建与容器启动兼容性 | 只能证明实际覆盖的启动/页面能力，不据此宣称复杂业务理解能力 |
| investment-research-system | 多服务、真实上游依赖工作流 | 相关真实依赖和账号具备后验收；未具备就明确未验证，不删测试换通过 |

表中是目标验收范围，具体业务用例应先从这些锁定版本的真实源码和运行行为确认再固定。目前外部 preflight 对 FastAPI 没有配置 checks，Next.js 仅做构建，必须补齐，不能把脚本退出成功计作这些业务场景通过。

业务缺陷在隔离 checkout 中通过明确代码变更形成，执行真实应用，不拦截接口伪造结果。支持状态按每个项目记录 detected→built→started→business-verified→repair-verified；只有最后实际完成的级别对外声明。

**必需的端到端验收矩阵**

| 编号 | 实际操作 | 必需结果 |
| --- | --- | --- |
| E01 | 空环境真实用户登录并接入外部项目 | 项目进入可执行状态，所有前置条件有实际检查 |
| E02 | 模型规划后删路径、新增路径、确认 | 确认快照、调度和轨迹完全一致，无静默遗漏 |
| E03 | 两项目切换、后台运行完成、刷新页面 | 当前项目状态不串扰，历史运行可回看 |
| E04 | 健康版本执行完整目标路径 | 独立预期通过，有本次动作、断言和证据 |
| E05 | 真实缺陷版本执行相同目标路径 | 独立断言失败，不能假绿；健康对照仍通过 |
| E06 | 真实模型生成修复，应用到副本并回归 | 原失败变通过，既定回归通过；撤销补丁后再失败 |
| E07 | 通过验证后再次编辑，尝试应用 | 旧验证失效，服务端拒绝应用旧批准 |
| E08 | 另一组织用户获取已知证据引用 | 拒绝下载和元数据泄露；原组织用户正常读取 |
| E09 | 运行中取消，API/worker 分进程 | 实际停止目标动作、浏览器和容器，有清理结果 |
| E10 | worker 退出、重复消息、聚合超时 | 安全恢复或明确终态，旧代次不覆盖新结果 |
| E11 | 对象丢失/被修改、数据库或模型不可达 | 明确 blocked/失败，不能用旧证据或规则假冒本次 AI 成功 |
| E12 | 两个不同项目并发、同一确认重复提交 | 项目资源隔离，重复请求幂等，结果和证据不串 Run |

针对模型有随机性的业务案例预先规定有限预算和重复次数，建议初期每个关键正反对照 3 次，并全部报告。重试属于结果的一部分，不能只挑最好一次。此小样本是流程验收，不用于宣称泛化准确率；统计能力声明需要另行固定更大独立样本及接受标准。

每次发布验收包至少包含：版本/源码摘要、镜像和锁文件摘要、计划快照、脱敏配置摘要、实际服务健康记录、模型调用 id/模型/用量/延迟/调用状态、Run/Attempt/代次、实际浏览器 trace、截图与 DOM、业务接口/数据断言、对象哈希验证、缺陷前后与撤销补丁的对照、全部检查计数和未决原因。配置摘要不得包含或泄露凭据。

**H. 把外围能力也接到真实执行事实**

- 需求、diff 和缺陷来源：记录真实读取位置、版本/内容哈希和授权结果。连接失败显示失败；演示 fallback 不进入正式验收输入。项目审查采用哪些输入应在运行记录中明确。
- 模型能力探测：复用已有真实结构化/流式 preflight，并检查后续使用的工具调用能力。GET /models 可见不等于所有任务能力可用，/models 不受支持也应通过实际推理能力探测判断。
- 通知：未配置渠道显示未配置，不以 simulated 计送达。真正的渠道验收在专用测试接收端核验返回码、业务确认字段和消息 id；只对明确授权的接收端发送。
- 巡检：复用相同快照、授权、执行与证据管线；持久计划、去重、防重叠、失败退避和重启恢复必须通过真实调度验证。
- 测试资产：保存实际可执行测试文件及依赖；稳定性重复执行只在独立副本进行。改变预期为不可能字符串只能验证断言活性，不能代替真实产品缺陷检出率。
- 历史记忆：只有经过验证且绑定源码/环境版本的知识可作为执行依据；新版本命中旧记忆必须重新核验，不能用历史成功补本次缺失证据。
- 原生桌面与高级连接器：逐项显示未配置、已配置、已验证及其时间/证据，只有真实调用验收通过才标已验证。未实现能力从实际操作入口移除或准确显示不可用。

**数据迁移和上线顺序**

先增加向后可读的新表/字段与版本化契约，再上线新写入流程和迁移工具；只读核对旧数据后切换生产数据源。无摘要的历史修复验证保留为历史记录，但不能授权当前补丁应用；历史计划不可从分页 UI 猜补为“用户当时确认”的快照。历史未知指标保留未知，不反填为 0。最后停用旧的直接目录下载和文件式生产写入，并用真实普通用户重新验收。

部署与业务变更分批发布，保留原版本服务和迁移前备份。回滚不删除新产生的 Run/证据；出现版本不兼容时停止新任务，保留可解释状态，再恢复兼容服务。

**开始真实验收时的前置条件**

需要可用的受控执行节点、实际模型凭据及调用预算、上述锁定项目的源码与真实依赖、OIDC 测试用户和独立数据环境。实施时逐项检查现有配置并安全复用授权凭据；缺少条件则给出具体阻塞项，不填假值、不触发演示回退。当前只是方案阶段，无需为写方案调用模型、发消息或变更这些外部系统。

第一项可交付里程碑是：一个真实外部项目在干净部署中，由普通用户通过实际工作台完成“登录→接入→模型规划→修改范围→确认→真实执行→查看证据→发现实际缺陷→模型修复→回归→下载与验证一致的补丁”，并同时通过范围、授权、旧验证失效和取消的反向检查。该里程碑完成后，再逐一扩大已经实证的项目与技术栈范围。
