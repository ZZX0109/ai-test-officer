import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  approveScenarioDraft,
  createHarnessGapScenarioDraft,
  listScenarioDrafts,
  probeScenarioDraft,
  writeScenarioDraft,
  writeHarnessGaps
} from "../src/harnessGapStore.js";
import { getScenario, hasScenario } from "../src/scenarios.js";
import type { HarnessGap } from "../src/types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export async function testScenarioDraftLifecycle() {
  const gap: HarnessGap = {
    id: `gap_scenario_draft_${Date.now()}`,
    createdAt: new Date().toISOString(),
    source: "requirement",
    requirementSummary: "需要覆盖搜索 keyword 的真实路径",
    missingScenarioTitle: "搜索任务 keyword 回归",
    requiredCapabilities: ["scenario_harness_extension", "selector_probe", "oracle_builder"],
    suggestedOracle: "搜索后页面必须展示 TODO 任务",
    suggestedSteps: ["打开页面", "输入 keyword", "点击搜索"],
    status: "open"
  };
  await writeHarnessGaps([gap]);
  const draft = await createHarnessGapScenarioDraft(gap.id);
  assert.ok(draft);
  assert.equal(draft.draftReviewStatus, "draft");
  assert.equal(draft.selectorProbeStatus, "not_run");
  assert.ok(draft.evidenceRequirements?.includes("screenshot"));

  const probed = await probeScenarioDraft(draft.scenarioId);
  assert.equal(probed?.selectorProbeStatus, "passed");
  const approved = await approveScenarioDraft(draft.scenarioId);
  assert.equal(approved?.draftReviewStatus, "approved");
  assert.equal(approved?.selectorProbeStatus, "passed");
  assert.ok(approved?.installedFile?.includes("data/scenarios"));
  assert.ok((await listScenarioDrafts()).some((item) => item.scenarioId === draft.scenarioId));
  assert.equal(hasScenario(draft.scenarioId), true, "an approved draft must be executable without restarting the Agent");
  assert.equal(getScenario(draft.scenarioId).id, draft.scenarioId);
  if (approved?.installedFile) {
    await rm(path.join(rootDir, approved.installedFile), { force: true });
  }
}

export async function testScenarioDraftCannotTrustEmptyMissingInfo() {
  const scenarioId = `discovered_invalid_form_${Date.now()}`;
  const draft = await writeScenarioDraft({
    gapId: `gap_${scenarioId}`,
    createdAt: new Date().toISOString(),
    scenarioId,
    draftReviewStatus: "draft",
    selectorProbeStatus: "not_run",
    missingInfo: [],
    scenario: {
      id: scenarioId,
      title: "Invalid discovered form",
      planObservation: "discovery",
      smoke: {
        pathId: "open",
        stepId: "open",
        title: "open",
        headingName: "Fixture",
        assertionName: "visible",
        expected: "Fixture"
      },
      corePath: {
        pathId: "form",
        stepId: "form",
        title: "submit",
        action: "complex_form_validate",
        targetLocator: "body",
        riskReason: "test",
        oracles: [{
          id: "form_dom",
          name: "form dom",
          type: "dom_text",
          locator: "body",
          expectedTextIncludes: "Fixture",
          expected: "Fixture"
        }]
      }
    }
  });
  assert.equal(draft.missingInfo?.includes("corePath.submitButtonName"), true);
  const probed = await probeScenarioDraft(scenarioId);
  assert.equal(probed?.selectorProbeStatus, "failed");
  const approved = await approveScenarioDraft(scenarioId);
  assert.notEqual(approved?.draftReviewStatus, "approved");
  assert.equal(hasScenario(scenarioId), false);
  await rm(path.join(rootDir, "reports", "harness-gaps", "drafts", `${scenarioId}.json`), { force: true });
}
