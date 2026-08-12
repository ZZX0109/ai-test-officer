import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { diagnoseBenchmarkRun, hasCompleteBenchmarkTrace } from "../src/benchmark.js";
import { assessPlannerOutcome, deriveBenchmarkExecutionSignals, lanesRequireLlm, requestedScenarioForLane, validateBenchmarkFixtureBindings, validateBenchmarkProjectMappings } from "../src/benchmarkRunner.js";
import { createRunRequestSchema } from "@ai-test-officer/contracts";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export async function testBenchmarkContract() {
  const benchmarkInput = createRunRequestSchema.parse({
    organizationId: "benchmark",
    projectId: "todo_lite",
    idempotencyKey: "benchmark-contract",
    input: { requirement: "验证已完成筛选", executionProfile: "benchmark" }
  });
  assert.equal(benchmarkInput.input.executionProfile, "benchmark");
  assert.equal(createRunRequestSchema.parse({
    organizationId: "benchmark",
    projectId: "todo_lite",
    idempotencyKey: "interactive-contract",
    input: { requirement: "默认交互运行" }
  }).input.executionProfile, "interactive");
  const scenarioCase = { id: "todo-filter-completed", split: "development" as const, projectId: "todo_lite", requirement: "filter", diff: "filter", risk: "high" };
  assert.equal(requestedScenarioForLane(scenarioCase, "rules-deterministic"), "task_filter_completed");
  assert.equal(lanesRequireLlm(["rules-deterministic", "test-command"]), false, "deterministic service smoke must not require a model preflight");
  assert.equal(lanesRequireLlm(["rules-deterministic", "full-llm"]), true);
  assert.equal(requestedScenarioForLane(scenarioCase, "llm-plan-deterministic-judge"), undefined);
  assert.equal(requestedScenarioForLane(scenarioCase, "full-llm"), undefined);
  const blindCase = { id: "blind-001", split: "blind" as const, projectId: "todo_lite", requirement: "unknown requirement", diff: "unknown diff", risk: "high" };
  assert.equal(requestedScenarioForLane(blindCase, "rules-deterministic"), undefined, "blind rules lane must not receive evaluator scenario labels");
  const holdoutCase = { id: "holdout-001", split: "holdout" as const, projectId: "todo_lite", requirement: "unknown requirement", diff: "unknown diff", risk: "high" };
  assert.equal(requestedScenarioForLane(holdoutCase, "rules-deterministic"), undefined, "holdout rules lane must not receive evaluator scenario labels");
  assert.deepEqual(assessPlannerOutcome("llm"), { planExecutable: false, plannerFailed: true });
  assert.deepEqual(assessPlannerOutcome("llm", { source: "llm", compilationStatus: "rejected", model: "model", llmCallId: "call" }), { planExecutable: false, plannerFailed: true });
  assert.deepEqual(assessPlannerOutcome("llm", { source: "llm", compilationStatus: "validated", model: "model", llmCallId: "call" }), { planExecutable: true, plannerFailed: false });
  assert.deepEqual(assessPlannerOutcome("llm", { source: "deterministic", compilationStatus: "validated" }), { planExecutable: false, plannerFailed: true });
  const completeSignals = deriveBenchmarkExecutionSignals({
    riskCoverageMatrix: [{ covered: true, passed: true }],
    assertions: [{ passed: true }],
    artifactIntegrity: { items: [{ status: "present" }] },
    evidenceQuality: { assertions: [{ status: "grounded" }], summary: { groundedPassedRate: 1, crossAttemptViolations: 0 } }
  }, [{ origin: "runtime-captured", integrity: { sha256: "a".repeat(64), sizeBytes: 1 } }]);
  assert.deepEqual(completeSignals, { executionStarted: true, requirementCovered: true, requirementPassed: true, executionSucceeded: true, artifactIntegrityVerified: true, evidenceGrounded: true, gateEligible: true });
  const aggregateSignals = deriveBenchmarkExecutionSignals({
    assertions: [{ passed: true }],
    attempts: [{ id: "aggregate-attempt" }],
    outcomeSummary: {
      schemaVersion: "2.0",
      schedulingCompleted: true,
      executionStarted: true,
      executionSucceeded: true,
      requirementCovered: true,
      requirementPassed: true,
      artifactIntegrityVerified: true,
      evidenceGrounded: true,
      gateEligible: true,
      machineGate: { status: "pass", reasons: [], reasonDetails: [], assertionFailures: [], evidenceComplete: true },
      judgeRecommendation: { status: "pass", summary: "child evidence verified", evidenceRefs: [] },
      finalStatus: "pass"
    }
  }, [{ origin: "runtime-captured", integrity: { sha256: "b".repeat(64), sizeBytes: 1 } }]);
  assert.deepEqual(aggregateSignals, { executionStarted: true, requirementCovered: true, requirementPassed: true, executionSucceeded: true, artifactIntegrityVerified: true, evidenceGrounded: true, gateEligible: true }, "parent aggregate must preserve child coverage facts from the verified v2 outcome summary");
  assert.equal(hasCompleteBenchmarkTrace({
    benchmarkId: "aggregate-trace", runId: "parent-run", experimentId: "test", split: "development", lane: "rules-deterministic", repetition: 1, status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    attempts: [
      { id: "parent-aggregate-attempt", runId: "parent-run", scenarioId: "parent-coverage-aggregate", attempt: 1, status: "passed" },
      { id: "child-attempt", runId: "child-run", scenarioId: "task_create_success", attempt: 1, status: "passed" }
    ],
    artifactsV2: [
      { id: "parent-artifact", type: "operation-log", origin: "runtime-captured", sha256: "c".repeat(64), integrityStatus: "verified", runId: "parent-run", scenarioId: "parent-coverage-aggregate", stepId: "aggregate", attemptId: "parent-aggregate-attempt", attempt: 1, capturedAt: new Date().toISOString(), sizeBytes: 1, mediaType: "application/json", storageUri: "/artifacts/parent" },
      { id: "child-artifact", type: "screenshot", origin: "runtime-captured", sha256: "d".repeat(64), integrityStatus: "verified", runId: "child-run", scenarioId: "task_create_success", stepId: "open", attemptId: "child-attempt", attempt: 1, capturedAt: new Date().toISOString(), sizeBytes: 1, mediaType: "image/png", storageUri: "/artifacts/child" }
    ]
  }), true, "parent aggregate artifacts must remain traceable alongside child browser attempts");
  assert.equal(hasCompleteBenchmarkTrace({
    benchmarkId: "selective-judge-trace", runId: "parent-run", experimentId: "test", split: "development", lane: "rules-plan-llm-judge", repetition: 1, status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    attempts: [{ id: "attempt", runId: "parent-run", scenarioId: "task_create_success", attempt: 1, status: "passed" }],
    artifactsV2: [{ id: "artifact", type: "screenshot", origin: "runtime-captured", sha256: "e".repeat(64), integrityStatus: "verified", runId: "parent-run", scenarioId: "task_create_success", stepId: "open", attemptId: "attempt", attempt: 1, capturedAt: new Date().toISOString(), sizeBytes: 1, mediaType: "image/png", storageUri: "/artifacts/attempt" }]
  }), true, "a selective Judge lane remains traceable when the deterministic evidence is unambiguous and no Judge call is needed");
  const incompleteSignals = deriveBenchmarkExecutionSignals({
    riskCoverageMatrix: [{ covered: true, passed: false }],
    assertions: [{ passed: true }],
    artifactIntegrity: { items: [{ status: "present" }] },
    evidenceQuality: { assertions: [{ status: "grounded" }], summary: { groundedPassedRate: 1, crossAttemptViolations: 0 } }
  }, [{ origin: "runtime-captured", integrity: { sha256: "a".repeat(64), sizeBytes: 1 } }]);
  assert.equal(incompleteSignals.requirementCovered, true);
  assert.equal(incompleteSignals.requirementPassed, false);
  assert.equal(incompleteSignals.gateEligible, true, "a fully evidenced product failure remains decision eligible");
  const legacySignals = deriveBenchmarkExecutionSignals({
    assertions: [],
    artifactIntegrity: { items: [] },
    evidenceQuality: { assertions: [], summary: { groundedPassedRate: 0, crossAttemptViolations: 0 } }
  }, []);
  assert.deepEqual(legacySignals, {
    executionStarted: false,
    requirementCovered: false,
    requirementPassed: false,
    executionSucceeded: false,
    artifactIntegrityVerified: false,
    evidenceGrounded: false,
    gateEligible: false
  }, "legacy/blocked reports without a coverage matrix must fail closed");
  const handoffDiagnostic = diagnoseBenchmarkRun({
    benchmarkId: "todo-viewer-permission", runId: "run-handoff", status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    requestedScenarioId: "todo_visitor_permission", projectedScenarioId: "todo_visitor_permission", requirementCovered: false, executionSucceeded: false, retryCount: 0,
    deterministic: { verdict: "fail", evidenceRefs: [], status: "passed" }, evidence: [], artifactIntegrityVerified: false, gateEligible: false
  }, { benchmarkId: "todo-viewer-permission", verdict: "fail", expectedScenarioId: "todo_visitor_permission", requiredEvidenceTypes: [] });
  assert.ok(!handoffDiagnostic.effects.includes("scenario_selection_error"), "missing attempt is a handoff failure, not a Planner selection error");
  const cases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "cases.json"), "utf8")) as Array<{ id: string; projectId: string; category: string; scenarioId?: string; fixtureVariantId?: string; expectedVerdict?: string }>;
  assert.equal(cases.length, 18);
  assert.deepEqual(new Set(cases.map((item) => item.projectId)), new Set(["todo_lite", "order_portal_lite"]));
  assert.equal(cases.filter((item) => item.projectId === "todo_lite").length, 9);
  assert.equal(cases.filter((item) => item.projectId === "order_portal_lite").length, 9);
  assert.ok(new Set(cases.map((item) => item.category)).size >= 6);
  assert.ok(cases.every((item) => item.scenarioId === undefined), "Agent-readable development manifest must not reveal the evaluator scenario label");
  assert.ok(cases.every((item) => item.expectedVerdict === undefined));
  assert.equal(cases.find((item) => item.id === "order-api-failure")?.fixtureVariantId, "fxv_7f3a1c92d6e8405b");
  const todoPermissionScenario = await readFile(path.join(rootDir, "data", "scenarios", "todo-visitor-permission.json"), "utf8");
  assert.match(todoPermissionScenario, /"triggerButtonName":"退出登录"/);
  assert.match(todoPermissionScenario, /"triggerButtonName":"登录测试账号"/);
  const blindManifestText = await readFile(path.join(rootDir, "data", "benchmark", "blind-cases.json"), "utf8");
  const benchmarkRunnerText = await readFile(path.join(rootDir, "agent", "src", "benchmarkRunner.ts"), "utf8");
  assert.doesNotMatch(benchmarkRunnerText, /benchmark_execution_result_resume/, "benchmark runner must never forge a Worker execution result");
  assert.doesNotMatch(benchmarkRunnerText, /resumeUnattendedExecutionInterrupt/, "only the Worker may resume an execution-result interrupt");
  assert.match(benchmarkRunnerText, /executionProfile:\s*"benchmark"/, "benchmark creation must opt into one-path execution isolation");
  assert.doesNotMatch(benchmarkRunnerText, /"blind-\d+"\s*:/, "runner must not hard-code blind case mappings");
  assert.doesNotMatch(benchmarkRunnerText, /"holdout-\d+"\s*:/, "runner must not hard-code holdout case mappings");
  const blindCases = JSON.parse(blindManifestText) as Array<{ id: string; fixtureVariantId: string } & Record<string, unknown>>;
  assert.equal(blindCases.length, 6);
  assert.ok(blindCases.every((item, index) => item.id === `blind-${String(index + 1).padStart(3, "0")}`));
  assert.ok(blindCases.every((item) => /^fxv_[a-f0-9]{16}$/.test(item.fixtureVariantId)));
  assert.equal(new Set(blindCases.map((item) => item.fixtureVariantId)).size, blindCases.length);
  for (const forbiddenKey of ["scenarioId", "expectedScenarioId", "expectedVerdict", "verdict", "failureClass", "category", "faultProfile", "expectedEvidence", "requiredEvidenceTypes"]) {
    assert.ok(blindCases.every((item) => !(forbiddenKey in item)), `blind manifest must not expose ${forbiddenKey}`);
  }
  assert.doesNotMatch(blindManifestText, /product[_ -]?bug|environment[_ -]?(?:issue|error)|selector[_ -]?drift|permission[_ -]?bypass|insufficient[_ -]?evidence|drop[_ -]?trace|ambiguous[_ -]?oracle/i);
  const holdoutManifestText = await readFile(path.join(rootDir, "data", "benchmark", "holdout-cases.json"), "utf8");
  const holdoutCases = JSON.parse(holdoutManifestText) as Array<{ id: string; fixtureVariantId: string } & Record<string, unknown>>;
  assert.equal(holdoutCases.length, 6);
  assert.ok(holdoutCases.every((item, index) => item.id === `holdout-${String(index + 1).padStart(3, "0")}`));
  assert.ok(holdoutCases.every((item) => /^fxv_[a-f0-9]{16}$/.test(item.fixtureVariantId)));
  for (const forbiddenKey of ["scenarioId", "expectedScenarioId", "expectedVerdict", "verdict", "failureClass", "category", "faultProfile", "expectedEvidence", "requiredEvidenceTypes"]) {
    assert.ok(holdoutCases.every((item) => !(forbiddenKey in item)), `holdout manifest must not expose ${forbiddenKey}`);
  }
  const extendedCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "extended-cases.json"), "utf8")) as Array<{ id: string; projectId: string; scenarioId?: string }>;
  assert.equal(extendedCases.length, 6);
  assert.equal(new Set(extendedCases.map((item) => item.projectId)).size, 1);
  assert.equal(extendedCases.every((item) => item.projectId === "customer_portal_lite" && item.scenarioId === undefined), true);
  const developmentLabels = JSON.parse(await readFile(path.join(rootDir, "evaluation", "benchmark-labels", "development.json"), "utf8")) as Array<{ benchmarkId: string; expectedScenarioId?: string }>;
  const blindLabels = JSON.parse(await readFile(path.join(rootDir, "evaluation", "benchmark-labels", "blind.json"), "utf8")) as Array<{ benchmarkId: string; expectedScenarioId?: string }>;
  const extendedLabels = JSON.parse(await readFile(path.join(rootDir, "evaluation", "benchmark-labels", "extended.json"), "utf8")) as Array<{ benchmarkId: string; expectedScenarioId?: string }>;
  assert.deepEqual(new Set(developmentLabels.map((item) => item.benchmarkId)), new Set(cases.map((item) => item.id)));
  assert.deepEqual(new Set(blindLabels.map((item) => item.benchmarkId)), new Set(blindCases.map((item) => item.id)));
  assert.deepEqual(new Set(extendedLabels.map((item) => item.benchmarkId)), new Set(extendedCases.map((item) => item.id)));
  assert.ok([...developmentLabels, ...blindLabels, ...extendedLabels].every((item) => item.expectedScenarioId), "Only evaluator-owned labels may contain expected scenario IDs");
  assert.match(await readFile(path.join(rootDir, ".dockerignore"), "utf8"), /^evaluation$/m);
  const todo = JSON.parse(await readFile(path.join(rootDir, "data", "projects", "todo_lite.json"), "utf8")) as { testCommand?: string; allowedOrigins?: string[] };
  const order = JSON.parse(await readFile(path.join(rootDir, "data", "projects", "order_portal_lite.json"), "utf8")) as { testCommand?: string; allowedOrigins?: string[] };
  assert.equal(todo.testCommand, "npm test");
  assert.equal(order.testCommand, "npm test");
  assert.ok(todo.allowedOrigins?.length);
  assert.ok(order.allowedOrigins?.length);
  const executionMap = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "execution-map.json"), "utf8")) as { mappings: Array<Record<string, string>> };
  assert.deepEqual(executionMap.mappings.map(({ logicalProjectId, executionProjectId, targetKind }) => ({ logicalProjectId, executionProjectId, targetKind })), [
    { logicalProjectId: "todo_lite", executionProjectId: "local_demo_app", targetKind: "app-under-test" },
    { logicalProjectId: "order_portal_lite", executionProjectId: "order_portal_lite", targetKind: "independent-fixture" },
    { logicalProjectId: "customer_portal_lite", executionProjectId: "customer_portal_lite", targetKind: "independent-fixture" }
  ]);
  assert.doesNotThrow(() => validateBenchmarkProjectMappings({ development: cases, extended: extendedCases, blind: blindCases, holdout: holdoutCases, mappings: executionMap.mappings }));
  const fixtureVariants = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "fixture-variants.json"), "utf8")) as { variants: Array<{ fixtureVariantId: string; logicalProjectId: string; executionProjectId: string }> };
  const mappings = validateBenchmarkProjectMappings({ development: cases, extended: extendedCases, blind: blindCases, holdout: holdoutCases, mappings: executionMap.mappings });
  assert.doesNotThrow(() => validateBenchmarkFixtureBindings({ cases: [...cases, ...extendedCases, ...blindCases, ...holdoutCases], mappings, variants: fixtureVariants.variants }));
  assert.throws(() => validateBenchmarkFixtureBindings({
    cases: [...cases, ...extendedCases, ...blindCases],
    mappings,
    variants: fixtureVariants.variants.map((item) => item.fixtureVariantId === "fxv_d30c9a3e6d4b0185" ? { ...item, executionProjectId: "customer_portal_lite" } : item)
  }), /benchmark_fixture_variant_project_mismatch:order-viewer-permission/);
  assert.throws(() => validateBenchmarkProjectMappings({
    development: cases,
    extended: extendedCases,
    blind: blindCases,
    mappings: executionMap.mappings.map((item) => item.logicalProjectId === "order_portal_lite" ? { ...item, executionProjectId: "customer_portal_lite" } : item)
  }), /benchmark_mapping_invalid:order_portal_lite/);
  const challengeCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "challenge-cases.json"), "utf8")) as Array<{ projectId: string; evaluationScope: string }>;
  assert.ok(challengeCases.length >= 6, "complex investment challenge must cover more than one happy path");
  assert.equal(challengeCases.every((item) => item.projectId === "investment_agent_workflow_external"), true);
  assert.equal(challengeCases.every((item) => item.evaluationScope === "challenge_only"), true);
}
