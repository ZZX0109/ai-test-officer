import assert from "node:assert/strict";
import { BudgetTracker, buildOciInvocation, classifyRuntimeFailure, resolveManifestWorkspace } from "../src/index.js";
import { projectManifestSchema } from "@ai-test-officer/contracts";

const manifest = projectManifestSchema.parse({ schemaVersion: "1.0", projectId: "demo", workspaceRoot: "fixture", commandAllowlist: ["npm"], commands: { start: { executable: "npm", args: ["run", "dev"] } }, execution: { mode: "trusted-local" } });
assert.match(buildOciInvocation({ engine: "podman", image: "node:22", manifest, repositoryRoot: "/repo", command: manifest.commands.start! }).args.join(" "), /--read-only/);
assert.equal(resolveManifestWorkspace(manifest, "/repo"), "/repo/fixture");
assert.equal(classifyRuntimeFailure(new Error("EADDRINUSE")), "port_conflict");
const tracker = new BudgetTracker({ ...manifest.budget, maxSteps: 1 });
tracker.consume({ steps: 1 });
assert.throws(() => tracker.consume({ steps: 1 }), /budget_exceeded/);
console.log("execution worker tests passed");
