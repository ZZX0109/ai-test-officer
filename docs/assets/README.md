# 文档图片来源

这些图片用于说明界面和目标工作流，不是端到端测试通过的证据。

| 文件 | 来源与状态 |
| --- | --- |
| [workbench-overview.png](workbench-overview.png) | 实际工作台首页；未选择项目、未配置模型、未执行测试 |
| [workbench-project-setup.png](workbench-project-setup.png) | 实际“配置与证据 → 项目与运行配置”抽屉；展示当前缺失条件 |
| [workbench-model-setup.png](workbench-model-setup.png) | 实际模型配置弹窗；凭据列表为空 |
| [workflow-overview.svg](workflow-overview.svg) | 可维护的原生 SVG 流程说明，明确标注完整闭环仍在整改验收 |

**截图条件（2026-09-06）**

- 使用真实仓库 React/Vite 源码、已构建的 Express API 和 Playwright Chromium，Node.js 24.13.0，视口 1600 × 1000。
- API 与 UI 在独立临时目录和独立本机端口运行；未加载原工作区凭据、环境文件、历史项目或运行报告。所需静态数据来自仓库已跟踪文件。
- 通过实际按钮打开抽屉与弹窗，等界面动画结束后直接截图；没有拦截 API 制造响应、注入 DOM 内容、修改结果或后期合成界面。
- 未配置模型、未启动目标项目，也未执行“官方演示”。项目卡片来自系统内置配置，卡片文案不是本次验收记录。默认规则的 13 步不是本次模型生成的计划。
- 截图时没有浏览器脚本异常。演示验收历史接口返回 404，因为独立环境没有历史报告；未据此生成成功记录。
- 模型弹窗背后的模糊效果来自产品自身 CSS。截图不包含真实密钥或私有项目内容。

复查图片时，先核对下列 SHA-256，再结合 [README](../../README.md) 的当前状态与 [修复方案](../remediation-plan.md) 阅读。这里的摘要仅用于核对文档图片，不代表业务证据完整性已经验收。

| 文件 | SHA-256 |
| --- | --- |
| `workbench-overview.png` | `dd9823f6e3ba2aa31babeac0ba497dc35f2f1d0fedbf76aeac649139e7bbe136` |
| `workbench-project-setup.png` | `736de07e30decc5fd93c2a991212523238fbe0035bf93095a2860febb8ffd7fb` |
| `workbench-model-setup.png` | `d34578491c3f7b44d4bc2ff3d055e43b27267fc36f17657ef58c7c3cd24eee6c` |
| `workflow-overview.svg` | `270a733b7e6e92d15eb545c8a8c8b7e7fe33e34cf66164fe2e779260d4ea38f6` |

原来的 `ai-test-officer-workbench-v2.png` 及 `docs/user-guide/` 中的图片是历史界面材料；当前 README 使用本页列出的新截图。
