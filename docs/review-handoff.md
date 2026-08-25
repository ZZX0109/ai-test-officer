# 外部审阅交接说明

请以压缩包根目录的 `pasted-text-1.txt`（若存在）作为本轮优化的权威验收要求；它由用户在仓库外提供，打包时以原文件名带入。若该文件不存在，审阅者应先索取它，而不是把示例 fixture 的通过当作完整交付。

## 建议阅读顺序

1. `README.md`、`docs/architecture-one-page.md`、`docs/research-grounded-reliability-architecture.md`。
2. `agent/src/react/`、`agent/src/structuredCoverageRunner.ts`、`agent/src/testRunner.ts`：ReAct/编排与执行。
3. `agent/src/projectAdapter.ts`、`agent/src/isolatedRuntimeUrls.ts`、`agent/src/sandboxRuntimeUrls.ts`、`agent/src/ociEgress.ts`、`packages/execution-worker/src/`：外部项目 OCI 运行时、隔离网络和资源限制。
4. `deploy/production-acceptance/`、`scripts/production-acceptance.mjs`、`reports/production-acceptance/latest.json`：生产验收与可审计结果。
5. `data/benchmark/README.md`、`evaluation/`：基准、盲测与评测边界。

## 本轮已验证的事实

- Linux/arm64 干净安装基线通过：安装、浏览器依赖、lint、类型检查、主测试、构建、工作台 E2E、统一运行、可信度浏览器检查、出口代理验收、仓库外项目 smoke。
- 仓库外项目 smoke 复制 `customer-portal-lite` 到仓库外目录；目标以 Docker `--internal` 私有 bridge 启动，Agent 通过私有地址完成健康检查、页面发现、动态场景绑定，并生成截图、DOM 与网络证据。
- `reports/production-acceptance/latest.json` 是一份已通过的 45 项生产验收摘要。其检查覆盖 Postgres、Redis、MinIO、OIDC、对象存储、幂等写入和进程故障恢复等。

## 仍不能声称完成的严格证据

- 基准实际运行需要外部模型凭证；基线环境报 `credential_env_missing`。评估还需要显式 `BENCHMARK_EXPERIMENT_ID`。
- 五个异构真实项目、封闭盲测、1/10/50 并发容量矩阵、安全对抗报告和生产 SLO/告警数据，均不能由当前 fixture 或静态测试替代。
- 本轮嵌套 Docker 的 Compose 构建未进入生产验收断言；这是验证环境阻塞，不能覆盖已有 45 项通过摘要，也不能被当成新的生产通过证据。

审阅时请将“代码与本地/fixture 回归通过”同“外部泛化、盲测和生产运行证据”分开判定。
