import { runRequirementAcceptance } from "./requirementAcceptanceOrchestrator.js";

function readList(value: string | undefined, fallback: string[]) {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : fallback;
}

const appUrl = process.env.APP_URL ?? "http://localhost:6173";
const scenarioId = process.env.SCENARIO_ID;
const credentialId = process.env.CREDENTIAL_ID;
const strictInput = process.env.STRICT_INPUT === "1";
const prUrl = process.env.PR_URL ?? (strictInput ? undefined : "local://cli/requirement-acceptance");
const prDiffUrl = process.env.PR_DIFF_URL;
const requirementUrl = process.env.REQUIREMENT_URL;
const requirementPath =
  process.env.REQUIREMENT_PATH ?? (strictInput || requirementUrl ? undefined : "data/fixtures/task-filter-requirement.md");
const bugTicketUrl = process.env.BUG_TICKET_URL;
const bugTicketPath =
  process.env.BUG_TICKET_PATH ?? (strictInput || bugTicketUrl ? undefined : "data/fixtures/tapd-task-filter-bug.md");
const openApiUrl = process.env.OPENAPI_URL;
const openApiPath = process.env.OPENAPI_PATH;
const fallbackDiff = process.env.FALLBACK_DIFF ?? (strictInput ? undefined : "requirement acceptance for task filter");
const notify = readList(process.env.NOTIFY, ["product-owner", "qa-oncall"]);

runRequirementAcceptance({
  appUrl,
  scenarioId,
  credentialId,
  prUrl,
  prDiffUrl,
  requirementPath,
  requirementUrl,
  bugTicketPath,
  bugTicketUrl,
  openApiPath,
  openApiUrl,
  fallbackDiff,
  strictInput,
  notify,
  permissionProfile: {
    observe: true,
    browserControl: true,
    workspaceControl: false,
    ideTerminalControl: false,
    systemControl: false
  }
})
  .then((acceptance) => {
    console.log(JSON.stringify({
      id: acceptance.id,
      selectedScenarioId: acceptance.selectedScenarioId,
      planSource: acceptance.planSource,
      verdict: acceptance.run?.verdict ?? "skipped",
      releaseJudge: acceptance.run?.judgeReport.releaseJudge.verdict,
      readableReport: acceptance.run?.htmlReportFile ?? acceptance.run?.markdownReportFile,
      deliveryStatus: acceptance.delivery?.status,
      skippedReason: acceptance.skippedReason,
      acceptanceFile: acceptance.acceptanceFile
    }, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
