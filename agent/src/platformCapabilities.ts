import type { PlatformCapability } from "./types.js";

export function listPlatformCapabilities(): PlatformCapability[] {
  return [
    {
      id: "mcp_git_diff",
      title: "MCP 连接器读取 Git/PR diff",
      status: "implemented",
      purpose: "开发提交后自动抽取变更文件、接口参数和高风险路径。",
      demoAction: "POST /api/connectors/context 读取本地 git diff；传入 GitHub PR URL 时自动尝试读取 .diff。"
    },
    {
      id: "mcp_requirement_doc",
      title: "MCP 连接器读取需求文档",
      status: "implemented",
      purpose: "产品或需求文档输入后自动拆成可执行测试场景和验收断言。",
      demoAction: "POST /api/connectors/context 读取 requirementPath 或 requirementUrl。"
    },
    {
      id: "mcp_issue_bug",
      title: "MCP 连接器读取 GitHub/Jira/TAPD 缺陷单",
      status: "implemented",
      purpose: "把线上缺陷、历史问题和回归优先级纳入计划判断。",
      demoAction: "POST /api/connectors/context 读取 bugTicketPath 或 bugTicketUrl；GitHub issue、Jira issue 和普通 TAPD/Bug URL 会进入不同 source context。"
    },
    {
      id: "playwright_mcp",
      title: "Playwright MCP 接管真实浏览器",
      status: "implemented",
      purpose: "可视化执行鼠标、键盘、浏览器操作，采集截图、DOM、network、console。",
      demoAction: "POST /api/run-visual-test 或 /api/patrol/run-now。"
    },
    {
      id: "scheduler",
      title: "定时任务巡检核心路径",
      status: "implemented",
      purpose: "脱离 PR 触发，持续检查线上或准线上核心功能。",
      demoAction: "POST /api/patrol/start 启动 interval 调度，POST /api/patrol/run-now 立即执行。"
    },
    {
      id: "bot_notifier",
      title: "bot 机器人推送值班",
      status: process.env.BOT_WEBHOOK_URL ? "implemented" : "simulated",
      purpose: "把异常、证据 ID、报告链接整理后发送给开发或值班人员。",
      demoAction: "配置 BOT_PROVIDER=wecom 和 BOT_WEBHOOK_URL 后按企业微信 markdown 真实 POST；未配置时保存本地模拟记录。"
    }
  ];
}
