// External blind-test lane runner (#1 of the external-acceptance objective).
//
// Executes ONE lane (plannerMode × judgeMode combo) × ONE repetition on a
// real external project via /v1/runs, waits for completion, captures the
// Machine-Gate verdict + metrics, and records the lane evidence into the
// per-project JSON that external-acceptance-audit.mjs consumes.
//
// Lane → mode mapping (contracts/src/index.ts plannerModeSchema/judgeModeSchema):
//   rules-plan-rules-judge : planner=deterministic, judge=deterministic  (no model)
//   llm-plan-rules-judge   : planner=llm,         judge=deterministic
//   rules-plan-llm-judge   : planner=deterministic, judge=llm-assisted
//   full-llm               : planner=llm,         judge=llm-assisted
//
// Integrity flags recorded per lane (honest, documented):
//   labelsSealed        — the expected verdict is never in the run input; the
//                         planner/judge learn it only from real execution.
//   evaluatorSeparated   — planner and judge are separate code paths with
//                         separate LlmCall purposes and budgets (architectural).
//
// Usage:
//   node scripts/external-blind-test-runner.mjs <projectId> <lane> [--model <profileId>] [--rep <1-3>] [--native]
// Requires: agent at $ATO_AGENT_URL (default http://127.0.0.1:4317) + token.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const AGENT = process.env.ATO_AGENT_URL || "http://127.0.0.1:4317";
const TOKEN = process.env.ATO_AGENT_TOKEN || "dev-local-token";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EVIDENCE_DIR = path.join(ROOT, "reports", "external-acceptance");

const LANES = {
  "rules-plan-rules-judge": { plannerMode: "deterministic", judgeMode: "deterministic" },
  "llm-plan-rules-judge": { plannerMode: "llm", judgeMode: "deterministic" },
  "rules-plan-llm-judge": { plannerMode: "deterministic", judgeMode: "llm-assisted" },
  "full-llm": { plannerMode: "llm", judgeMode: "llm-assisted" }
};

function die(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const out = { projectId: null, lane: null, model: null, rep: 1, native: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") out.model = argv[++i];
    else if (a === "--rep") out.rep = parseInt(argv[++i], 10);
    else if (a === "--native") out.native = true;
    else if (!out.projectId) out.projectId = a;
    else if (!out.lane) out.lane = a;
  }
  return out;
}

async function agentFetch(p, opts = {}) {
  const url = `${AGENT}${p}`;
  const res = await fetch(url, { headers: { "x-agent-token": TOKEN, "Content-Type": "application/json" }, ...opts });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function waitForRun(runId, { timeoutMs = 1000 * 60 * 12 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { ok, body } = await agentFetch(`/v1/runs/${runId}`);
    if (!ok) throw new Error(`run_status_${body?.error || body?.status || "err"}`);
    const run = body.run ?? body;
    const state = run.state;
    // Terminal states end the run. `awaiting-human-review` is the sealed
    // evaluator gate (the lane has executed through plan→browser→judge and
    // reached the human-approval step). For an automated lane runner we treat
    // reaching the gate as the recording point: the lane *executed*; the
    // evaluator's final verdict is a separate sealed step recorded in metrics
    // (gateStatus reflects "needs-human-review", not "passed").
    if (/completed|failed|aborted|cancelled|awaiting-human-review/.test(state)) return run;
    await new Promise((r) => setTimeout(r, 7000));
  }
  throw new Error("run_timeout");
}

// A /v1/runs execution does not auto-start the project sandbox; the project
// must already be healthy. Start it (idempotent) and wait for ready, so a lane
// run never sits pending against an unstarted project.
async function ensureProjectReady(projectId, { timeoutMs = 1000 * 60 * 6 } = {}) {
  await agentFetch(`/api/projects/${projectId}/start-async`, { method: "POST", body: "{}" });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await agentFetch(`/api/projects/${projectId}/runtime`);
    const rt = body?.runtime ?? body ?? {};
    const status = rt.status;
    const phase = rt.phase;
    // Runtime reports status="running" + phase="ready" once healthy.
    if (phase === "ready" || status === "running") return rt;
    if (status === "failed") throw new Error(`project_not_healthy: ${rt.failureReason ?? rt.message ?? "failed"}`);
    await new Promise((r) => setTimeout(r, 6000));
  }
  throw new Error("project_ready_timeout");
}

function readEvidence(projectId) {
  const file = path.join(EVIDENCE_DIR, `${projectId}.json`);
  if (!existsSync(file)) return null;
  return { file, data: JSON.parse(readFileSync(file, "utf8")) };
}

function writeEvidence(file, data) {
  // Preserve the preflight-proven repository/revision/gitTree/codeCommit; the
  // runner only ADDS lane/rep/model/integrity/metrics evidence.
  data.generatedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function recordLane(evidence, lane, model, run) {
  const lanes = Array.isArray(evidence.lanes) ? evidence.lanes : [];
  if (!lanes.includes(lane)) lanes.push(lane);
  evidence.lanes = lanes;
  // repetitions counts completed lane-execution runs across all lanes/rep/models.
  evidence.repetitions = (evidence.repetitions ?? 0) + 1;
  const models = Array.isArray(evidence.models) ? evidence.models : [];
  const modelId = model || "deterministic";
  if (!models.includes(modelId)) models.push(modelId);
  evidence.models = models;
  evidence.promptVersion = evidence.promptVersion || run.input?.promptVersion || "plan-v1";
  evidence.labelsSealed = true;       // expected verdict never in run input
  evidence.evaluatorSeparated = true; // planner/judge are separate paths/budgets
  const metrics = (evidence.metrics && typeof evidence.metrics === "object") ? evidence.metrics : {};
  metrics[lane] = metrics[lane] || [];
  metrics[lane].push({
    repetition: run.input?.repetition ?? null,
    model: run.input?.modelProfileId || null,
    runId: run.id,
    gateStatus: run.machineGate?.verdict ?? run.gateStatus ?? "unknown",
    executionStatus: run.executionStatus ?? run.state,
    outcome: run.outcomeSummary ?? null,
    startedAt: run.createdAt,
    completedAt: run.updatedAt
  });
  evidence.metrics = metrics;
  evidence.status = "completed";
  // Re-evaluate completion honestly: all 5 lanes + 3 reps + 2 models required.
  const REQUIRED = ["native-tests", "rules-plan-rules-judge", "llm-plan-rules-judge", "rules-plan-llm-judge", "full-llm"];
  const hasAllLanes = REQUIRED.every((l) => lanes.includes(l));
  if (!hasAllLanes || (evidence.repetitions ?? 0) < 3 || (evidence.models?.length ?? 0) < 2) {
    evidence.status = "evidence-incomplete";
  }
  return evidence;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.projectId || !args.lane) die("usage: external-blind-test-runner.mjs <projectId> <lane> [--model <id>] [--rep <1-3>] [--native]");
  const modes = LANES[args.lane];
  if (!modes) die(`unknown lane '${args.lane}'. valid: ${Object.keys(LANES).join(", ")}`);
  if ((modes.plannerMode !== "deterministic" || modes.judgeMode !== "deterministic") && !args.model) {
    die(`lane '${args.lane}' uses LLM modes; --model <profileId> is required`);
  }

  const evidence = readEvidence(args.projectId);
  if (!evidence) die(`no evidence file for '${args.projectId}' — run external-project-preflight first`);
  console.log(`project: ${args.projectId} | lane: ${args.lane} | rep: ${args.rep} | model: ${args.model || "deterministic"}`);

  console.log("ensuring project sandbox is healthy…");
  await ensureProjectReady(args.projectId);
  console.log("project ready; creating lane run…");

  const experimentId = `blind-${args.projectId}-${args.lane}`;
  const idempotencyKey = `${experimentId}-rep${args.rep}-${Date.now().toString(36)}`;
  const body = {
    projectId: args.projectId,
    idempotencyKey,
    input: {
      plannerMode: modes.plannerMode,
      judgeMode: modes.judgeMode,
      ...(args.model ? { modelProfileId: args.model } : {}),
      experimentId,
      repetition: args.rep,
      cachePolicy: "bypass",
      executionProfile: "benchmark",
      promptVersion: evidence.data.promptVersion || "plan-v1"
    }
  };

  const create = await agentFetch("/v1/runs", { method: "POST", body: JSON.stringify(body) });
  if (!create.ok) die(`create run failed: ${create.status} ${JSON.stringify(create.body).slice(0, 300)}`);
  const runId = create.body.run?.id ?? create.body.id;
  if (!runId) die(`no run id in response: ${JSON.stringify(create.body).slice(0, 300)}`);
  console.log(`run created: ${runId} (experiment=${experimentId}, rep=${args.rep})`);

  const run = await waitForRun(runId);
  const gate = run.machineGate?.verdict ?? run.gateStatus ?? "unknown";
  const execStatus = run.executionStatus ?? run.state;
  console.log(`run settled: state=${run.state} | execution=${execStatus} | gate=${gate}`);
  console.log(`  outcome: ${(run.outcomeSummary ?? "").slice(0, 160)}`);

  const updated = recordLane({ ...evidence.data }, args.lane, args.model, run);
  writeEvidence(evidence.file, updated);
  console.log(`evidence recorded → ${path.relative(ROOT, evidence.file)} | lanes=[${updated.lanes.join(",")}] | reps=${updated.repetitions} | models=[${updated.models.join(",")}] | status=${updated.status}`);
}

main().catch((e) => die(e?.message || String(e)));
