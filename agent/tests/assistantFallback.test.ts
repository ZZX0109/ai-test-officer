import assert from "node:assert/strict";
import {
  assistantReplyNeedsNormalization,
  buildDeterministicAssistantFallback,
  deterministicAssistantCall,
  requestedAssistantAction
} from "../src/assistantFallback.js";

export function testAssistantFallback() {
  assert.equal(requestedAssistantAction("重新启动 Docker 沙盒"), undefined);
  assert.equal(requestedAssistantAction("重新扫描页面并绑定路径"), undefined);
  assert.equal(requestedAssistantAction("重试失败链路"), undefined);
  assert.equal(requestedAssistantAction("开始测试"), "start-run");
  assert.equal(requestedAssistantAction("查看本次证据"), "open-evidence");
  const binding = buildDeterministicAssistantFallback({
    userMessage: "重试失败链路",
    projectName: "PsyExpGen",
    summary: "3 条候选路径没有通过页面绑定",
    evidenceCount: 8,
    planning: {
      discovered: 27,
      executable: 1,
      autoBindable: 26,
      confirmed: true,
      failures: [{
        title: "实验创建流程",
        target: "/experiments/new",
        stage: "binding",
        detail: "没有找到可提交实验的按钮",
        requiredInformation: ["确认创建按钮名称"]
      }],
      blockingQuestions: []
    }
  });
  assert.match(binding.reply, /遇到的问题：/);
  assert.match(binding.reply, /实验创建流程/);
  assert.match(binding.reply, /没有找到可提交实验的按钮/);
  assert.match(binding.reply, /系统已经做了什么：/);
  assert.match(binding.reply, /需要你做什么：/);
  assert.equal(binding.suggestedAction, "none");
  assert.equal(binding.requiresConfirmation, false);

  const timeoutBinding = buildDeterministicAssistantFallback({
    userMessage: "用简单的话解释失败原因",
    summary: "1 条候选路径没有通过页面绑定",
    planning: {
      discovered: 8,
      executable: 7,
      autoBindable: 7,
      confirmed: true,
      failures: [{
        title: "实验创建流程",
        stage: "binding",
        detail: "probe.page_unavailable:page.waitForFunction: Timeout 8000ms exceeded"
      }]
    }
  });
  assert.match(timeoutBinding.reply, /目标页面在等待时间内没有出现可操作内容/);
  assert.doesNotMatch(timeoutBinding.reply, /probe\.page_unavailable|waitForFunction|Timeout 8000ms/);

  const boundedObservation = buildDeterministicAssistantFallback({
    userMessage: "页面扫描为什么失败？",
    summary: "1 条候选路径没有通过页面绑定",
    pageObservation: {
      id: "discovery_without_screenshot",
      requestedUrl: "http://127.0.0.1:6173/",
      finalUrl: "http://127.0.0.1:6173/",
      stage: "dom-ready",
      status: "degraded",
      navigation: { documentCommitted: true, httpStatus: 200 },
      document: { interactiveElementCount: 0, controls: [] },
      console: [],
      pageErrors: [],
      failedRequests: [{
        method: "GET",
        url: "http://127.0.0.1:6173/api/items",
        status: 503,
        resourceType: "fetch",
        failure: "HTTP 503"
      }],
      diagnosis: {
        summary: "页面已打开，但尚未渲染可操作控件。",
        likelyCauses: ["页面存在失败的网络请求"],
        retryable: true,
        userActionRequired: false
      }
    },
    planning: {
      discovered: 1,
      executable: 0,
      autoBindable: 0,
      confirmed: false,
      failures: [{
        title: "任务列表",
        stage: "binding",
        detail: "页面没有可操作控件"
      }],
      blockingQuestions: []
    }
  });
  assert.match(boundedObservation.reply, /发现 1 个失败请求/);
  assert.match(boundedObservation.reply, /无需操作/);
  assert.match(boundedObservation.reply, /无需提供账号密码/);
  assert.match(boundedObservation.reply, /冷加载策略/);
  assert.doesNotMatch(boundedObservation.reply, /页面截图/);
  assert.equal(boundedObservation.suggestedAction, "none");
  assert.equal(boundedObservation.requiresConfirmation, false);

  const authenticationObservation = buildDeterministicAssistantFallback({
    userMessage: "为什么测试不能继续？",
    summary: "登录页面尚未配置测试凭据",
    pageObservation: {
      id: "discovery_login",
      requestedUrl: "http://127.0.0.1:6173/",
      finalUrl: "http://127.0.0.1:6173/signin",
      stage: "completed",
      status: "degraded",
      navigation: { documentCommitted: true, httpStatus: 200 },
      document: {
        interactiveElementCount: 2,
        controls: [{
          kind: "input",
          accessibleName: "Password",
          inputType: "password",
          visible: true,
          disabled: false
        }]
      },
      console: [],
      pageErrors: [],
      failedRequests: [],
      diagnosis: {
        summary: "页面跳转到登录入口。",
        likelyCauses: ["需要认证"],
        retryable: false,
        userActionRequired: true
      }
    },
    planning: {
      discovered: 1,
      executable: 0,
      autoBindable: 0,
      confirmed: false,
      failures: [{
        title: "登录后主页",
        stage: "binding",
        detail: "登录页面缺少测试凭据"
      }],
      blockingQuestions: ["是否提供测试账号？"]
    }
  });
  assert.match(authenticationObservation.reply, /明确认证证据/);
  assert.match(authenticationObservation.reply, /凭据配置/);

  const execution = buildDeterministicAssistantFallback({
    userMessage: "这是怎么回事",
    currentStep: "保存实验",
    failedAssertions: [{
      name: "保存后显示实验编号",
      expected: "页面显示 experiment id",
      actual: "页面仍停留在编辑表单"
    }]
  });
  assert.match(execution.reply, /保存后显示实验编号/);
  assert.match(execution.reply, /页面仍停留在编辑表单/);
  assert.equal(execution.suggestedAction, "none");

  const proofLink = buildDeterministicAssistantFallback({
    userMessage: "分析失败原因并告诉我下一步",
    finalStatus: "blocked",
    summary: "operation_discovered_settings:proof_bundle_missing_artifact",
    evidenceCount: 7
  });
  assert.match(proofLink.reply, /证据.*关联校验没有通过/);
  assert.match(proofLink.reply, /无需上传附件/);
  assert.doesNotMatch(proofLink.reply, /proof_bundle|operation_/);
  assert.doesNotMatch(proofLink.reasoningSummary.observations.join(" "), /proof_bundle|operation_/);
  assert.equal(proofLink.suggestedAction, "none");
  assert.equal(proofLink.requiresConfirmation, false);

  const recoveryQuestion = buildDeterministicAssistantFallback({
    userMessage: "系统能否自动恢复，我需要做什么？",
    finalStatus: "blocked",
    summary: "proof_invalid:proof_bundle_missing_artifact"
  });
  assert.equal(recoveryQuestion.suggestedAction, "none");

  const graphAuthorizedRecovery = buildDeterministicAssistantFallback({
    userMessage: "系统能否自动恢复？",
    finalStatus: "blocked",
    summary: "页面绑定失败",
    repairDecision: {
      owner: "agent",
      type: "discovery_incomplete",
      executable: true,
      userMessage: "Graph 已确认可重新扫描当前页面。",
      steps: ["重新观察页面", "重新绑定控件"],
      validation: "产生新的页面观测和绑定结果"
    }
  });
  assert.equal(graphAuthorizedRecovery.suggestedAction, "retry-discovery");
  assert.equal(graphAuthorizedRecovery.requiresConfirmation, true);

  const startupFailure = buildDeterministicAssistantFallback({
    userMessage: "为什么 ANDFlow 没办法运行？",
    projectName: "ANDFlow",
    projectDiagnostic: {
      runtimeStatus: "failed",
      runtimePhase: "waiting_for_health",
      failureReason: "health_timeout",
      runtimeMessage: "Project connection failed: health_timeout",
      failedStages: [{
        stage: "frontend",
        reason: "frontend_unreachable",
        humanMessage: "前端地址在等待时间内没有响应"
      }]
    }
  });
  assert.match(startupFailure.reply, /项目尚未进入可测试状态/);
  assert.match(startupFailure.reply, /前端地址在等待时间内没有响应/);
  assert.match(startupFailure.reply, /正式测试尚未开始/);
  assert.match(startupFailure.reply, /不会把启动失败误报为产品缺陷或测试通过/);
  assert.equal(startupFailure.suggestedAction, "none");

  const healthyModelFallback = buildDeterministicAssistantFallback({
    userMessage: "现在测试到哪了？",
    runState: "running",
    finalStatus: "pass"
  });
  assert.match(healthyModelFallback.reply, /模型解释暂时不可用/);
  assert.match(healthyModelFallback.reply, /没有因此把测试标成失败或通过/);
  assert.doesNotMatch(healthyModelFallback.reply, /当前测试处于阻塞|等待确认状态/);

  assert.equal(assistantReplyNeedsNormalization({
    reply: "请上传 operation_example 对应的缺失证明附件",
    reasoningSummary: {
      assessment: "proof_bundle_missing_artifact"
    }
  }), true);
  assert.equal(assistantReplyNeedsNormalization({
    reply: "页面没有响应，系统已保留截图和日志。",
    reasoningSummary: {
      assessment: "当前需要重新运行失败路径。"
    }
  }), false);
  const noAuthObservation = {
    requestedUrl: "http://127.0.0.1:6173/",
    finalUrl: "http://127.0.0.1:6173/",
    stage: "completed",
    status: "degraded" as const,
    navigation: { documentCommitted: true, httpStatus: 200 },
    document: { interactiveElementCount: 0, controls: [] },
    console: [],
    pageErrors: [],
    failedRequests: [],
    diagnosis: {
      summary: "页面仍在冷加载。",
      likelyCauses: ["前端初始化较慢"],
      retryable: true,
      userActionRequired: false
    }
  };
  assert.equal(assistantReplyNeedsNormalization({
    reply: "请提供测试账号和密码后继续。",
    pageObservation: noAuthObservation
  }), true);
  assert.equal(assistantReplyNeedsNormalization({
    reply: "系统已经保存页面截图，正在分析。",
    pageObservation: noAuthObservation
  }), true);
  assert.equal(assistantReplyNeedsNormalization({
    reply: "请通过凭据配置绑定测试账号。",
    pageObservation: {
      ...noAuthObservation,
      finalUrl: "http://127.0.0.1:6173/signin",
      document: {
        interactiveElementCount: 1,
        controls: [{
          kind: "input",
          inputType: "password",
          visible: true,
          disabled: false
        }]
      },
      diagnosis: {
        ...noAuthObservation.diagnosis,
        userActionRequired: true
      }
    }
  }), false);

  const call = deterministicAssistantCall(new Error("provider_http_400 Validation failed"), {
    provider: "openai-compatible",
    model: "gpt-5.1-codex",
    durationMs: 321
  });
  assert.equal(call.fallbackApplied, true);
  assert.equal(call.errorCode, "assistant_output_invalid");
  assert.equal(call.status, "failed");
  assert.equal(call.durationMs, 321);
}
