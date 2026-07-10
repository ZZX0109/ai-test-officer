import { runPatrolNow } from "./patrolScheduler.js";

function readList(value: string | undefined, fallback: string[]) {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : fallback;
}

const appUrl = process.env.APP_URL ?? "http://localhost:6173";
const jobId = process.env.PATROL_JOB_ID ?? "core_path_cli";
const scenarioId = process.env.SCENARIO_ID ?? "task_filter_completed";
const credentialId = process.env.CREDENTIAL_ID;
const requirement = process.env.REQUIREMENT ?? "核心路径巡检：任务筛选功能必须保持可用。";
const diff = process.env.DIFF ?? "patrol baseline";
const notify = readList(process.env.NOTIFY, ["oncall"]);

runPatrolNow({
  appUrl,
  jobId,
  scenarioId,
  credentialId,
  requirement,
  diff,
  notify,
  permissionProfile: {
    observe: true,
    browserControl: true,
    workspaceControl: false,
    ideTerminalControl: false,
    systemControl: false
  }
})
  .then((result) => {
    console.log(JSON.stringify({
      id: result.patrol.id,
      jobId: result.patrol.jobId,
      scenarioId: result.patrol.scenarioId,
      verdict: result.run.verdict,
      releaseJudge: result.run.judgeReport.releaseJudge.verdict,
      readableReport: result.run.htmlReportFile ?? result.run.markdownReportFile,
      deliveryStatus: result.delivery.status,
      patrolFile: result.patrol.patrolFile
    }, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
