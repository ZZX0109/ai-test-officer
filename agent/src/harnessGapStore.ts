import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessGap, HarnessGapScenarioDraft } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const gapDir = path.join(rootDir, "reports", "harness-gaps");
const draftDir = path.join(gapDir, "drafts");
const scenarioDir = path.join(rootDir, "data", "scenarios");
const indexFile = path.join(gapDir, "index.json");
const latestFile = path.join(gapDir, "latest.json");

function draftFile(scenarioId: string) {
  return path.join(draftDir, `${scenarioId}.json`);
}

async function readAll() {
  try {
    const raw = await readFile(indexFile, "utf8");
    return JSON.parse(raw) as HarnessGap[];
  } catch {
    return [];
  }
}

async function writeAll(gaps: HarnessGap[]) {
  await mkdir(gapDir, { recursive: true });
  await writeFile(indexFile, JSON.stringify(gaps.slice(-200), null, 2));
  await writeFile(latestFile, JSON.stringify(gaps.at(-1) ?? null, null, 2));
}

export async function writeHarnessGaps(gaps: HarnessGap[]) {
  if (gaps.length === 0) return [];
  await mkdir(gapDir, { recursive: true });
  const all = await readAll();
  const written: HarnessGap[] = [];
  for (const gap of gaps) {
    const file = path.join(gapDir, `${gap.id}.json`);
    await writeFile(file, JSON.stringify(gap, null, 2));
    all.push(gap);
    written.push(gap);
  }
  await writeAll(all);
  return written;
}

export async function listHarnessGaps() {
  return readAll();
}

export async function updateHarnessGap(id: string, input: Partial<Pick<HarnessGap, "status">>) {
  const all = await readAll();
  const index = all.findIndex((gap) => gap.id === id);
  if (index === -1) return undefined;
  const updated: HarnessGap = {
    ...all[index],
    ...input
  };
  all[index] = updated;
  await writeAll(all);
  await writeFile(path.join(gapDir, `${id}.json`), JSON.stringify(updated, null, 2));
  return updated;
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "generated-scenario";
}

function inferDraftAction(gap: HarnessGap) {
  const text = `${gap.requirementSummary}\n${gap.missingScenarioTitle}\n${gap.suggestedOracle}`;
  if (/status=completed|已完成/i.test(text)) return { action: "click_filter", button: "已完成", query: "status=completed" };
  if (/status=active|进行中/i.test(text)) return { action: "click_filter", button: "进行中", query: "status=active" };
  if (/搜索|keyword|search/i.test(text)) return { action: "search_keyword", button: "搜索", query: "keyword=TODO" };
  if (/空状态|无数据|empty|暂无/i.test(text)) return { action: "expect_empty_state", button: "搜索", query: "keyword=TODO" };
  if (/错误|异常|error|timeout|500|503/i.test(text)) return { action: "simulate_error_and_retry", button: "模拟错误", query: "status=error" };
  if (/必填|required|表单|创建|新增/i.test(text)) return { action: "submit_empty_form", button: "新增", query: "" };
  return { action: "fill_and_submit", button: "新增", query: "" };
}

function buildDraftScenario(gap: HarnessGap) {
  const inferred = inferDraftAction(gap);
  const scenarioId = `generated_${slug(gap.missingScenarioTitle)}`;
  const isSearch = inferred.action === "search_keyword" || inferred.action === "expect_empty_state";
  const isError = inferred.action === "simulate_error_and_retry";
  const isRequired = inferred.action === "submit_empty_form";
  return {
    id: scenarioId,
    title: `${gap.missingScenarioTitle}（草案）`,
    planObservation: "smoke -> generated core_path -> regression",
    summary: `由 harness gap ${gap.id} 生成的 scenario 草案，需要人工确认 locator、输入和 oracle。`,
    matcher: {
      keywords: Array.from(new Set([
        ...gap.missingScenarioTitle.split(/\s+/),
        ...gap.requiredCapabilities,
        "generated",
        "harness-gap"
      ])).filter(Boolean).slice(0, 12),
      riskLevel: "medium",
      sourceHints: [gap.source],
      capabilities: gap.requiredCapabilities
    },
    smoke: {
      pathId: "open_task_page",
      stepId: "open_task_page",
      title: "打开任务列表页",
      headingName: "任务管理系统",
      assertionName: "页面标题可见",
      expected: "任务管理系统标题出现"
    },
    corePath: {
      pathId: `${scenarioId}_path`,
      stepId: `${scenarioId}_step`,
      retryStepId: `retry_${scenarioId}_path`,
      title: gap.missingScenarioTitle,
      action: inferred.action,
      triggerButtonName: inferred.button,
      submitButtonName: inferred.button,
      retryButtonName: isError ? "重试" : undefined,
      inputLabel: isSearch ? "搜索任务" : undefined,
      input: isSearch ? "TODO" : undefined,
      networkUrlIncludes: "/api/tasks",
      expectedQueryFragment: inferred.query || undefined,
      targetLocator: isError ? "[data-testid='task-title']" : "[data-testid='task-list']",
      validationLocator: isRequired ? "[data-testid='title-error']" : undefined,
      expectedValidationText: isRequired ? "请输入任务标题" : undefined,
      emptyStateLocator: inferred.action === "expect_empty_state" ? "[data-testid='empty-state']" : undefined,
      expectedEmptyText: inferred.action === "expect_empty_state" ? "暂无任务" : undefined,
      errorLocator: isError ? "[data-testid='error-state']" : undefined,
      expectedErrorText: isError ? "任务接口失败" : undefined,
      expectedTextIncludes: "TODO",
      queryAssertionName: inferred.query ? `${gap.missingScenarioTitle} 请求参数符合预期` : undefined,
      domAssertionName: `${gap.missingScenarioTitle} 页面结果符合预期`,
      riskReason: gap.suggestedOracle,
      oracles: [
        ...(inferred.query ? [{
          id: `${scenarioId}_query`,
          name: `${gap.missingScenarioTitle} 请求参数符合预期`,
          type: "network_query",
          networkUrlIncludes: "/api/tasks",
          expectedQueryFragment: inferred.query,
          expected: `GET /api/tasks?${inferred.query}`
        }] : []),
        {
          id: `${scenarioId}_dom`,
          name: `${gap.missingScenarioTitle} 页面结果符合预期`,
          type: isRequired ? "validation_text" : inferred.action === "expect_empty_state" ? "empty_state" : isError ? "error_text" : "dom_text",
          locator: isRequired
            ? "[data-testid='title-error']"
            : inferred.action === "expect_empty_state"
              ? "[data-testid='empty-state']"
              : isError
                ? "[data-testid='error-state']"
                : "[data-testid='task-list']",
          expectedTextIncludes: isRequired ? "请输入任务标题" : isError ? "任务接口失败" : "TODO",
          expected: gap.suggestedOracle
        }
      ]
    },
    regressionPath: {
      stepId: "all_filter_regression",
      title: "继续执行全部筛选回归路径",
      action: "click_filter",
      triggerButtonName: "全部"
    }
  };
}

function corePathOf(scenario: Record<string, unknown>) {
  return scenario.corePath && typeof scenario.corePath === "object"
    ? scenario.corePath as Record<string, unknown>
    : {};
}

function draftEvidenceRequirements(scenario: Record<string, unknown>) {
  const core = corePathOf(scenario);
  const oracles = Array.isArray(core.oracles) ? core.oracles as Array<Record<string, unknown>> : [];
  const requirements = new Set(["screenshot", "dom"]);
  for (const oracle of oracles) {
    if (oracle.type === "network_query") requirements.add("network");
    if (oracle.type === "console_no_error") requirements.add("console");
  }
  return Array.from(requirements);
}

function enrichDraft(draft: HarnessGapScenarioDraft): HarnessGapScenarioDraft {
  const core = corePathOf(draft.scenario);
  const locator =
    core.targetLocator ??
    core.statusLocator ??
    core.validationLocator ??
    core.emptyStateLocator ??
    core.errorLocator;
  const oracles = Array.isArray(core.oracles) ? core.oracles as Array<Record<string, unknown>> : [];
  const missingInfo = [
    typeof core.action === "string" ? undefined : "corePath.action",
    typeof locator === "string" && locator.trim() ? undefined : "corePath selector locator",
    oracles.length ? undefined : "corePath.oracles"
  ].filter((item): item is string => Boolean(item));
  return {
    ...draft,
    draftReviewStatus: draft.draftReviewStatus ?? "draft",
    selectorProbeStatus: draft.selectorProbeStatus ?? "not_run",
    riskKind: draft.riskKind ?? "generated_harness_gap",
    selectors: draft.selectors ?? {
      role: core.triggerButtonName ?? core.submitButtonName ?? core.retryButtonName,
      text: core.expectedTextIncludes ?? core.expectedStatusText ?? core.expectedValidationText ?? core.expectedEmptyText ?? core.expectedErrorText,
      css: locator
    },
    actions: draft.actions ?? (typeof core.action === "string" ? [core.action] : []),
    oracles: draft.oracles ?? oracles,
    evidenceRequirements: draft.evidenceRequirements ?? draftEvidenceRequirements(draft.scenario),
    missingInfo: draft.missingInfo ?? missingInfo
  };
}

async function writeDraft(draft: HarnessGapScenarioDraft) {
  await mkdir(draftDir, { recursive: true });
  const enriched = enrichDraft(draft);
  enriched.scenarioFile = `/artifacts/harness-gaps/drafts/${enriched.scenarioId}.json`;
  await writeFile(draftFile(enriched.scenarioId), JSON.stringify(enriched, null, 2));
  return enriched;
}

export async function writeScenarioDraft(draft: HarnessGapScenarioDraft) {
  return writeDraft(draft);
}

async function readDraft(id: string) {
  const { readdir } = await import("node:fs/promises");
  try {
    const direct = JSON.parse(await readFile(draftFile(id), "utf8")) as HarnessGapScenarioDraft;
    return enrichDraft(direct);
  } catch {
    // Fall through to gap-id lookup below.
  }
  try {
    const files = (await readdir(draftDir)).filter((file) => file.endsWith(".json"));
    for (const file of files) {
      const draft = enrichDraft(JSON.parse(await readFile(path.join(draftDir, file), "utf8")) as HarnessGapScenarioDraft);
      if (draft.gapId === id || draft.scenarioId === id) return draft;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function createHarnessGapScenarioDraft(id: string): Promise<HarnessGapScenarioDraft | undefined> {
  const gap = (await readAll()).find((item) => item.id === id);
  if (!gap) return undefined;
  const scenario = buildDraftScenario(gap);
  const draft: HarnessGapScenarioDraft = {
    gapId: gap.id,
    createdAt: new Date().toISOString(),
    scenarioId: String(scenario.id),
    scenario
  };
  return writeDraft(draft);
}

export async function installHarnessGapScenarioDraft(id: string): Promise<HarnessGapScenarioDraft | undefined> {
  const draft = await readDraft(id) ?? await createHarnessGapScenarioDraft(id);
  if (!draft) return undefined;
  const probed = draft.selectorProbeStatus === "passed" ? draft : await probeScenarioDraft(draft.scenarioId);
  if (!probed || probed.selectorProbeStatus !== "passed") return probed;
  return approveScenarioDraft(probed.scenarioId);
}

export async function listScenarioDrafts() {
  const { readdir } = await import("node:fs/promises");
  try {
    const files = (await readdir(draftDir)).filter((file) => file.endsWith(".json")).sort();
    const drafts = await Promise.all(files.map(async (file) => enrichDraft(JSON.parse(await readFile(path.join(draftDir, file), "utf8")) as HarnessGapScenarioDraft)));
    return drafts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  } catch {
    return [];
  }
}

export async function probeScenarioDraft(id: string) {
  const draft = await readDraft(id);
  if (!draft) return undefined;
  const probed = enrichDraft({
    ...draft,
    selectorProbeStatus: draft.missingInfo?.length ? "failed" : "passed",
    missingInfo: draft.missingInfo ?? []
  });
  return writeDraft(probed);
}

export async function approveScenarioDraft(id: string) {
  const probed = await probeScenarioDraft(id);
  if (!probed || probed.selectorProbeStatus !== "passed") return probed;
  await mkdir(scenarioDir, { recursive: true });
  const installed = path.join(scenarioDir, `${probed.scenarioId}.json`);
  await writeFile(installed, JSON.stringify(probed.scenario, null, 2));
  const approved = await writeDraft({
    ...probed,
    draftReviewStatus: "approved",
    selectorProbeStatus: "passed",
    installedFile: path.relative(rootDir, installed)
  });
  await updateHarnessGap(approved.gapId, { status: "implemented" });
  return approved;
}
