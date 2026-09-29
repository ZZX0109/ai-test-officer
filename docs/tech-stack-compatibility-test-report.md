# 跨技术栈兼容性测试报告

> 本文合并了两类证据：下方 14 行矩阵是临时最小项目上的识别/配置测试；Docker、Node OCI 与系统依赖记录来自先前一次运行环境，本轮没有重跑。环境信息和历史全链路记录不能推断为当前主机状态。

## 测试结论

本轮以 **14 个最小、独立的项目** 作为被测项目，验证 AI Test Officer 的项目接入核心链路：目录识别、技术栈归类、安装命令、启动命令、端口、OCI 镜像、命令白名单和结构化命令。结果为 **14/14 通过**。

测试发现并修复 1 个 P0 缺陷：纯 Express 项目虽被识别为 3000 端口后端，但运行进程健康检查原先会指向默认前端端口 5173，可能将正常启动的项目误判为不可用。修复后，未包含 Vite 的 Express 项目统一以 3000 作为 Workbench 目标和进程健康检查地址。

这证明“项目识别与受控执行配置”层可用。Docker 已在本轮启动；其中独立 Node 项目已经完成真实 OCI 启动、隔离网络健康检查、动态页面发现、浏览器执行、Artifact 采集与停止清理。其他栈尚未完成真实启动：当前机器缺少 Go、Rust、Maven、Gradle、PHP/Composer，静态站点所需 `python:3.12-slim-bookworm` 镜像准备超过单次测试窗口。它们仍处于运行时验收阻塞状态，不能写成端到端通过。

## 测试范围

- 测试入口：[stackCompatibilityMatrix.test.ts](../agent/tests/stackCompatibilityMatrix.test.ts#L1)
- 执行方式：每个用例在临时目录创建最小项目，调用 `detectProject()`，不依赖网络、Docker 或预装框架。
- 断言内容：目录存在、技术栈标签、安装命令、启动命令、目标端口、OCI 执行模式、镜像、命令白名单、结构化启动命令。
- 回归：`npm --workspace @ai-test-officer/agent test` 通过。
- OCI 烟测：`RUN_EXTERNAL_PROJECT_SMOKE=1` 的 Node 外部项目链路有历史通过记录，本轮没有复跑；静态站点 OCI 烟测已纳入 [ociStaticRuntimeSmoke.test.ts](../agent/tests/ociStaticRuntimeSmoke.test.ts#L1)，受 `RUN_OCI_STATIC_SMOKE=1` 控制，未执行时不会验证容器启动。

## 技术栈矩阵

| 用例 | 被测项目功能内容 | 预期识别/执行配置 | 实际结果 |
| --- | --- | --- | --- |
| TS-01 Node + Vite + React | `package.json`、npm lock、Vite dev server | `node/react/vite`；`npm ci`；5173；Node 22 OCI 镜像 | 通过 |
| TS-02 Node + Express | Express API dev server | `node/express`；`npm install`；`npm run dev`；3000 | 通过，且覆盖本轮修复 |
| TS-03 Python + FastAPI | `requirements.txt`、`app.py`、ASGI app | `python/fastapi`；pip 安装；uvicorn；8000 | 通过 |
| TS-04 Python + Django | `requirements.txt`、`manage.py` | `python/django`；pip 安装；Django runserver；8000 | 通过 |
| TS-05 Python + Flask | `requirements.txt`、`main.py` | `python/flask`；pip 安装；Flask CLI；5000 | 通过 |
| TS-06 Python + Streamlit | `requirements.txt`、`app.py` | `python/streamlit`；pip 安装；Streamlit server；8501 | 通过 |
| TS-07 Python + Gradio | `requirements.txt`、`app.py` | `python/gradio`；pip 安装；Python app；7860 | 通过 |
| TS-08 Go | `go.mod`、`main.go` | `go`；`go run .`；8080；Golang OCI 镜像 | 通过 |
| TS-09 Rust | `Cargo.toml`、`src/main.rs` | `rust`；`cargo run`；8080；Rust OCI 镜像 | 通过 |
| TS-10 Java + Maven + Spring | `pom.xml` | `java/spring`；`mvn spring-boot:run`；8080；Maven JDK 21 镜像 | 通过 |
| TS-11 Java + Gradle + Spring | `build.gradle` | `java/spring`；`gradle bootRun`；8080；Gradle JDK 21 镜像 | 通过 |
| TS-12 Ruby + Rails | `Gemfile`、`config.ru` | `ruby/rails`；`bundle install`；Rails server；3000 | 通过 |
| TS-13 PHP + Laravel | `composer.json`、`artisan` | `php/laravel`；`composer install`；Laravel serve；8000 | 通过 |
| TS-14 Static HTML | `index.html` | `static`；无安装步骤；Python HTTP server；4173 | 通过 |

## 跨栈极端用例

| 用例 | 功能内容 | 预期结果 | 覆盖状态 |
| --- | --- | --- | --- |
| XE-01 不存在目录 | 路径校验与诊断 | 不生成可执行项目；诊断为 path failed，并提供重新选择路径提示 | 已有自动化覆盖 |
| XE-02 私有依赖 | npm、pip、Go、Cargo、Maven、Bundler、Composer 私有源/SSH 依赖 | 在启动前显示 blocker，不能静默联网安装或借用宿主凭据 | 已有自动化覆盖 |
| XE-03 端口冲突 | 目标端口已被未知进程占用 | 诊断展示冲突和建议；不终止来源不明的宿主进程 | 已有自动化覆盖 |
| XE-04 不安全命令 | 命令带 shell 元字符或不在 allowlist | 不生成结构化 CommandSpec，执行器拒绝运行 | 已有自动化覆盖 |
| XE-05 服务提前退出/健康检查超时 | 启动成功前崩溃或不可达 | 分类为运行时/环境问题，保留日志和失败证据，不能 pass | Agent 回归覆盖 |
| XE-06 无 Docker/缺语言运行时 | 当前开发机无法起 OCI 或本地编译 | 明确标记为环境阻塞，不将“未执行”记为平台通过 | 本轮实测 |
| XE-07 Node 全栈项目 | 同时有 Vite 与 Express | 优先保持 Vite 前端端口，不因 Express 回退为 3000 | 由 Express 修复的回归条件覆盖 |
| XE-08 内部网络健康检查 | `network.mode=deny` 的 OCI 沙盒从宿主不可直连 | 平台使用受控容器内探针确认健康，不将网络隔离误报为 health timeout | 本轮 Node OCI 实测通过 |

## 实际环境与运行时状态

| 能力 | 当前环境 | 影响 |
| --- | --- | --- |
| Docker daemon | 已启动，Server `29.3.1` | Node 外部项目已完成真实 OCI 全链路验收。 |
| Node | v20.20.2；测试封装可选择支持版本 | 可执行 Agent 自动化回归。 |
| Python | 3.10.10 | 仅可在安装对应依赖后本地启动 Python 样本；正式 OCI 镜像配置已验证。 |
| Go / Rust / Maven / Gradle / PHP / Composer | 未安装 | 不能在本机完成相应真实启动。 |
| Ruby | 2.6.10 | 低于平台配置的 Ruby 3.3 容器基线，未作为 Rails 运行时通过依据。 |
| Static OCI image | `python:3.12-slim-bookworm` 尚未就绪 | 静态站点启动测试未完成；临时项目和容器均已清理。 |

## 缺陷记录

| ID | 级别 | 现象 | 根因 | 处理与验证 |
| --- | --- | --- | --- | --- |
| BUG-TS-001 | P0 | 纯 Express 项目主进程健康检查默认使用 5173，而 Express 后端默认 3000 | 前端默认端口仅按 Next/Vite 推断，未区分无 Vite 的 Express | 已在 [projectDetection.ts](../agent/src/projectDetection.ts#L919) 修复；`TS-02` 识别/配置断言通过。 |
| BUG-OCI-002 | P0 | deny-network OCI 沙盒启动后，后续连接检查曾以宿主机 fetch 误判失败 | `testProjectConnection()` 未复用隔离网络探针 | 已在 [projectAdapter.ts](../agent/src/projectAdapter.ts#L314) 修复；Node OCI 烟测的历史记录报告通过，本轮未重跑。 |

## 下一阶段验收门槛

1. 启动 Docker daemon，并为每个技术栈运行 `detect -> save -> diagnose -> start -> health -> stop`。
2. 为每个可提供网页的样本至少执行一条浏览器路径；为 API 服务执行 OpenAPI 合约与故障路径。
3. 注入端口冲突、启动崩溃、网络拒绝、超时和 Artifact 篡改，确认所有栈均落入正确 Gate 状态。
4. 仅在每个项目拥有 runtime-captured Artifact、完整证明链和确定性 Gate 后，才将该技术栈标记为端到端兼容。
