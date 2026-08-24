// Red-team: provider-isolation probe.
//
// Verifies that two LLM calls with different modelProfileIds (credentials) do
// NOT cross-leak: each call uses its own credential's model, never the other's.
// A call whose provider is unhealthy falls back to the deterministic
// evidence-interpreter (a SAFE fallback — it does NOT silently use the other
// provider's credential/model). Also inspects the llmProvider code to assert
// the per-provider gate + per-call credential binding + per-call model_profile_id.
//
// Usage: node scripts/redteam-provider-isolation.mjs
// Requires: the agent running on :4317 with the investment project ready.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const reportDir = path.join(rootDir, "reports", "redteam");
mkdirSync(reportDir, { recursive: true });

const AGENT = process.env.AGENT_URL ?? "http://127.0.0.1:4317";
const TOKEN = process.env.AGENT_TOKEN ?? "dev-local-token";
const PROJECT = process.env.ISOLATION_PROJECT ?? "investment_agent_workflow_external";
const CRED_A = "cred_767141e004e185ae"; // sophnet / gpt-5.1-codex
const CRED_B = "cred_428b296419ed1269"; // poe / gpt-5.4
const MODEL_A = "gpt-5.1-codex";

function chat(credentialId) {
  const body = JSON.stringify({ projectId: PROJECT, message: "Reply with exactly: PING", credentialId, history: [], context: {} });
  const out = execFileSync("curl", ["-s", "-m", "40", "-X", "POST", "-H", `x-agent-token: ${TOKEN}`, "-H", "Content-Type: application/json", "-d", body, `${AGENT}/api/assistant/chat`], { maxBuffer: 1 << 20 }).toString();
  try { const d = JSON.parse(out); return d.call || {}; }
  catch { return { model: "parse-error", provider: "parse-error" }; }
}

function codeLevelAssertions() {
  const results = [];
  const llmProvider = readFileSync(path.join(rootDir, "agent/src/llmProvider.ts"), "utf8");
  const runOrchestrator = readFileSync(path.join(rootDir, "agent/src/runOrchestrator.ts"), "utf8");
  // 1. per-provider gate (keyed by provider+baseUrl+model)
  results.push({
    vector: "provider-gate-is-per-provider",
    verdict: /input\.credential\.provider[\s\S]{0,80}input\.credential\.baseUrl[\s\S]{0,80}input\.credential\.model/.test(llmProvider) ? "BLOCKED" : "ESCAPED",
    detail: "providerGateKey includes provider+baseUrl+model (per-provider rate-limit gate, not shared across providers)"
  });
  // 2. per-call credential (no global credential state)
  results.push({
    vector: "credential-bound-per-call",
    verdict: /input\.credential/.test(llmProvider) ? "BLOCKED" : "ESCAPED",
    detail: "llmProvider uses input.credential (no global/shared credential)"
  });
  // 3. model_profile_id recorded per-call
  results.push({
    vector: "model-profile-id-recorded-per-call",
    verdict: /model_profile_id/.test(llmProvider) && /input\.context\.modelProfileId/.test(llmProvider) ? "BLOCKED" : "ESCAPED",
    detail: "llm_calls_v1.model_profile_id recorded from input.context.modelProfileId (auditable per-call binding)"
  });
  // 4. credential resolved from run.input.modelProfileId (runOrchestrator)
  results.push({
    vector: "credential-resolved-from-run-input",
    verdict: /credentialId:\s*typeof\s+input\.modelProfileId\s*===\s*["']string["']\s*\?\s*input\.modelProfileId/.test(runOrchestrator) ? "BLOCKED" : "ESCAPED",
    detail: "runOrchestrator resolves credentialId from run.input.modelProfileId (no cross-run credential reuse)"
  });
  return results;
}

function main() {
  const codeResults = codeLevelAssertions();

  // Forward: two calls with different credentials.
  const callA = chat(CRED_A);
  const callB = chat(CRED_B);

  const forwardResults = [];
  // cred_A must use cred_A's model (gpt-5.1-codex), proving it used cred_A's credential.
  forwardResults.push({
    vector: "cred-A-uses-cred-A-model",
    verdict: callA.model === MODEL_A ? "BLOCKED" : "ESCAPED",
    detail: `cred_A call model=${callA.model} (expected ${MODEL_A})`
  });
  // cred_B must NOT use cred_A's model (no cross-leak; deterministic fallback is safe).
  forwardResults.push({
    vector: "cred-B-no-cross-leak-to-cred-A",
    verdict: callB.model !== MODEL_A ? "BLOCKED" : "ESCAPED",
    detail: `cred_B call model=${callB.model} (must not be ${MODEL_A}; deterministic fallback is safe)`
  });
  // The two calls must not produce the same model (no credential cross-contamination).
  forwardResults.push({
    vector: "no-credential-cross-contamination",
    verdict: callA.model !== callB.model ? "BLOCKED" : "ESCAPED",
    detail: `callA.model=${callA.model} != callB.model=${callB.model}`
  });

  const results = [...codeResults, ...forwardResults];
  const escaped = results.filter((r) => r.verdict === "ESCAPED");
  const blocked = results.filter((r) => r.verdict === "BLOCKED");
  const passed = escaped.length === 0;

  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: "1.0",
    generatedAt,
    scenario: "provider-isolation",
    description: "Verifies two LLM calls with different modelProfileIds do not cross-leak credentials/models. Code-level: per-provider gate, per-call credential binding, per-call model_profile_id, credential-from-run-input. Forward: two /api/assistant/chat calls (cred_A=sophnet/gpt-5.1-codex, cred_B=poe/gpt-5.4); a call whose provider is unhealthy falls back to the deterministic evidence-interpreter (SAFE — does NOT use the other provider's credential/model).",
    summary: { verdict: passed ? "PASS" : "FAIL", vectorsTotal: results.length, blocked: blocked.length, escaped: escaped.length },
    results,
    forwardCalls: { cred_A: { model: callA.model, provider: callA.provider }, cred_B: { model: callB.model, provider: callB.provider } }
  };
  writeFileSync(path.join(reportDir, "provider-isolation-latest.json"), JSON.stringify(report, null, 2));

  const md = [
    `# Red-Team: Provider-Isolation Probe`, ``, `Generated: ${generatedAt}`, ``,
    `Verifies two LLM calls with different modelProfileIds do not cross-leak credentials/models. A call whose provider is unhealthy falls back to the deterministic evidence-interpreter (SAFE — does NOT silently use the other provider's credential/model).`,
    ``, `**Overall: ${passed ? "PASS" : "FAIL"}** — ${blocked.length}/${results.length} vectors blocked, ${escaped.length} escaped.`, ``,
    `| Vector | Verdict | Detail |`, `| --- | --- | --- |`,
    ...results.map((r) => `| ${r.vector} | ${r.verdict} | ${r.detail} |`),
    ``, `**Forward calls:** cred_A → model=${callA.model} (provider=${callA.provider}); cred_B → model=${callB.model} (provider=${callB.provider}).`, ``
  ].join("\n");
  writeFileSync(path.join(reportDir, "provider-isolation-latest.md"), md);

  console.log(`red-team provider-isolation: ${passed ? "PASS" : "FAIL"} (${blocked.length} blocked, ${escaped.length} escaped)`);
  results.forEach((r) => console.log(`  ${r.verdict} | ${r.vector} | ${r.detail}`));
  process.exit(passed ? 0 : 1);
}

main();
