/**
 * Focused mutation gate for safety-critical behaviour.  Every mutant runs in
 * an isolated temporary copy of agent/src, so it never edits the working tree
 * or a user-uploaded project.  It complements (rather than replaces) a full
 * mutation framework while the TypeScript test runner remains custom.
 */
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const cases = [
  {
    id: "proof-integrity-missing-report",
    file: "agent/src/proof/proofBundleValidator.ts",
    find: "artifactIntegrityVerified = problems.length === 0;",
    replace: "artifactIntegrityVerified = true;",
    test: "proofBundleValidator.test.ts",
    exported: "testProofBundleValidator"
  },
  {
    id: "proof-dangling-evidence",
    file: "agent/src/proof/proofBundleValidator.ts",
    find: "const evidenceGrounded = unresolved.length === 0 && (hasClaims ? minimalEvidenceSet.length > 0 : evidence.length > 0);",
    replace: "const evidenceGrounded = true;",
    test: "proofBundleValidator.test.ts",
    exported: "testProofBundleValidator"
  },
  {
    id: "gate-eligible-without-execution",
    file: "agent/src/proof/proofBundleValidator.ts",
    find: "return facts.executionSucceeded && facts.requirementCovered && verdict.artifactIntegrityVerified && verdict.evidenceGrounded;",
    replace: "return true;",
    test: "proofBundleValidator.test.ts",
    exported: "testProofBundleValidator"
  },
  {
    id: "viewer-can-run-tests",
    file: "agent/src/projectAccess.ts",
    find: "viewer: [\"read_project\", \"read_artifacts\", \"read_reports\", \"read_evidence\"]",
    replace: "viewer: [\"read_project\", \"read_artifacts\", \"read_reports\", \"read_evidence\", \"run_tests\"]",
    test: "projectAuthorization.test.ts",
    exported: "testProjectAuthorizationMatrix"
  }
];

function run(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "pipe", env: { ...process.env, NODE_ENV: "test" } });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
    child.once("error", (error) => resolve({ code: 1, output: String(error) }));
  });
}

const results = [];
for (const mutation of cases) {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "ato-mutation-"));
  try {
    await cp(path.join(root, "agent", "src"), path.join(sandbox, "agent", "src"), { recursive: true });
    await mkdir(path.join(sandbox, "agent", "tests"), { recursive: true });
    await cp(path.join(root, "agent", "tests", mutation.test), path.join(sandbox, "agent", "tests", mutation.test));
    await symlink(path.join(root, "node_modules"), path.join(sandbox, "node_modules"), "dir");
    const target = path.join(sandbox, mutation.file);
    const source = await readFile(target, "utf8");
    if (!source.includes(mutation.find)) throw new Error(`mutation_anchor_missing:${mutation.id}`);
    await writeFile(target, source.replace(mutation.find, mutation.replace), "utf8");
    const runner = path.join(sandbox, "runner.ts");
    await writeFile(runner, `import { ${mutation.exported} } from "./agent/tests/${mutation.test}";\nawait ${mutation.exported}();\n`, "utf8");
    const outcome = await run(tsx, [runner], sandbox);
    results.push({ id: mutation.id, killed: outcome.code !== 0, output: outcome.output.slice(-1200) });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

const killed = results.filter((result) => result.killed).length;
const report = { generatedAt: new Date().toISOString(), total: results.length, killed, score: results.length ? killed / results.length : 0, results };
await mkdir(path.join(root, "reports", "mutation"), { recursive: true });
await writeFile(path.join(root, "reports", "mutation", "latest.json"), JSON.stringify(report, null, 2));
console.log(`Mutation score: ${(report.score * 100).toFixed(1)}% (${killed}/${results.length} killed)`);
if (killed !== results.length) {
  for (const result of results.filter((item) => !item.killed)) console.error(`Survived mutation: ${result.id}`);
  process.exitCode = 1;
}
