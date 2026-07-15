import type { GrayPlan } from "./types.js";
import type { ExecutableScenario } from "./scenarios.js";

export const fixedGrayPlan: GrayPlan = {
  sessionName: "任务状态筛选显式灰度验收",
  risks: [
    {
      id: "risk_status_query",
      level: "high",
      title: "状态筛选请求参数可能漏传",
      evidence: "diff 显示 fetchTasks 中查询参数被清空，已完成筛选可能无法传递 status=completed。",
      pathIds: ["completed_filter_path"], coverageDisposition: "required"
    },
    {
      id: "risk_list_rendering",
      level: "medium",
      title: "列表渲染可能展示错误任务集合",
      evidence: "任务列表依赖接口返回值，如果接口未过滤，页面会显示全部任务。",
      pathIds: ["completed_filter_path"], coverageDisposition: "required"
    },
    {
      id: "risk_empty_state",
      level: "low",
      title: "空状态和异常状态需要补测",
      evidence: "状态筛选变更可能影响无结果和接口错误场景。",
      pathIds: [], coverageDisposition: "harness_gap"
    }
  ],
  levels: [
    {
      id: "smoke",
      title: "Level 1 Smoke",
      description: "确认页面能打开、核心元素出现、没有明显浏览器错误。",
      paths: [
        {
          id: "open_task_page",
          title: "打开任务列表页",
          riskReason: "所有后续验证都依赖页面基础可用。",
          expectedFrom: "requirement",
          retry: 1,
          steps: ["打开 app_url", "检查任务列表标题", "检查筛选按钮出现", "检查 console 无明显错误"]
        }
      ]
    },
    {
      id: "core_path",
      title: "Level 2 Core Path",
      description: "验证本次 diff 直接影响的状态筛选核心路径。",
      paths: [
        {
          id: "completed_filter_path",
          title: "已完成任务筛选",
          riskReason: "diff 修改了筛选请求，必须验证 completed 路径。",
          expectedFrom: "requirement",
          retry: 1,
          steps: ["点击已完成", "检查请求包含 status=completed", "检查页面只显示 completed 任务"]
        }
      ]
    },
    {
      id: "edge_case",
      title: "Level 3 Edge Case",
      description: "验证空状态、接口异常和边界输入。",
      paths: [
        {
          id: "empty_and_error_states",
          title: "空状态与接口失败提示",
          riskReason: "筛选逻辑错误常伴随空状态和错误态缺失。",
          expectedFrom: "llm_inferred",
          retry: 1,
          steps: ["检查无数据筛选提示", "模拟接口失败", "检查错误提示"]
        }
      ]
    },
    {
      id: "regression",
      title: "Level 4 Regression",
      description: "验证相邻路径没有被本次变更破坏。",
      paths: [
        {
          id: "all_filter_regression",
          title: "切回全部并新建任务",
          riskReason: "筛选状态切换和新增任务是相邻高频路径。",
          expectedFrom: "existing_test",
          retry: 1,
          steps: ["点击全部", "新建进行中任务", "再次切换筛选状态"]
        }
      ]
    }
  ]
};

export function buildScenarioGrayPlan(scenario: ExecutableScenario): GrayPlan {
  const oracleSteps = scenario.corePath.oracles.map((oracle) => oracle.expected);
  const queryOracle = scenario.corePath.oracles.find((oracle) => oracle.type === "network_query");
  const domOracle = scenario.corePath.oracles.find((oracle) => oracle.type !== "network_query");
  const regressionPath = scenario.regressionPath ?? {
    stepId: "regression_not_configured",
    title: "未配置回归路径"
  };
  return {
    sessionName: `${scenario.title}显式灰度验收`,
    risks: [
      {
        id: "risk_core_request",
        level: scenario.matcher?.riskLevel ?? "high",
        title: "核心请求或操作可能不符合需求",
        evidence: queryOracle
          ? `变更或需求涉及 ${queryOracle.expectedQueryFragment}，必须验证请求是否携带该查询参数。`
          : `变更或需求命中 ${scenario.corePath.action}，必须验证核心操作有可观察结果。`,
        pathIds: [scenario.corePath.pathId], coverageDisposition: "required"
      },
      {
        id: "risk_visible_oracle",
        level: "medium",
        title: "页面可见结果可能与需求不一致",
        evidence: domOracle?.expected ?? "页面 DOM、截图或错误态需要和需求 oracle 对齐。",
        pathIds: [scenario.corePath.pathId], coverageDisposition: "required"
      },
      {
        id: "risk_empty_state",
        level: "low",
        title: "空状态和异常状态需要补测",
        evidence: "状态筛选变更可能影响无结果和接口错误场景。",
        pathIds: [], coverageDisposition: "harness_gap"
      }
    ],
    levels: [
      {
        id: "smoke",
        title: "Level 1 Smoke",
        description: "确认页面能打开、核心元素出现、没有明显浏览器错误。",
        paths: [
          {
            id: scenario.smoke.pathId,
            title: scenario.smoke.title,
            riskReason: "所有后续验证都依赖页面基础可用。",
            expectedFrom: "requirement",
            retry: 1,
            steps: ["打开 app_url", scenario.smoke.expected, "检查筛选按钮出现", "检查 console 无明显错误"]
          }
        ]
      },
      {
        id: "core_path",
        title: "Level 2 Core Path",
        description: "验证本次 diff 或需求直接影响的核心路径。",
        paths: [
          {
            id: scenario.corePath.pathId,
            title: scenario.corePath.title,
            riskReason: scenario.corePath.riskReason,
            expectedFrom: "requirement",
            retry: 1,
            steps: [`执行 ${scenario.corePath.action}`, ...oracleSteps]
          }
        ]
      },
      {
        id: "regression",
        title: "Level 4 Regression",
        description: "验证相邻路径没有被本次变更破坏。",
        paths: [
          {
            id: regressionPath.stepId,
            title: regressionPath.title,
            riskReason: "筛选状态切换和新增任务是相邻高频路径。",
            expectedFrom: "existing_test",
            retry: 1,
            steps: [regressionPath.triggerButtonName ? `点击${regressionPath.triggerButtonName}` : "执行回归路径", "确认页面仍可操作"]
          }
        ]
      }
    ]
  };
}
