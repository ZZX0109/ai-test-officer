import assert from "node:assert/strict";
import { BudgetTracker, buildOciInvocation, classifyRuntimeFailure, resolveManifestWorkspace } from "../src/index.js";
import { projectManifestSchema } from "@ai-test-officer/contracts";

const manifest = projectManifestSchema.parse({
  schemaVersion: "1.0",
  projectId: "demo",
  workspaceRoot: "fixture",
  commandAllowlist: ["npm"],
  commands: {
    install: { executable: "npm", args: ["ci"] },
    start: { executable: "npm", args: ["run", "dev"] }
  },
  execution: { mode: "trusted-local" }
});
const invocation = buildOciInvocation({
  engine: "podman",
  image: "node:22",
  manifest,
  repositoryRoot: "/repo",
  prepareCommand: manifest.commands.install,
  command: manifest.commands.start!,
  portBindings: [{ hostPort: 5173, containerPort: 5173 }]
});
assert.match(invocation.args.join(" "), /--read-only/);
assert.match(invocation.args.join(" "), /dst=\/source,readonly/);
assert.match(invocation.args.join(" "), /\/workspace:rw,exec,nosuid/);
assert.match(invocation.args.join(" "), /127\.0\.0\.1:5173:5173/);
assert.match(invocation.args.join(" "), /npm.*ci/);
assert.match(invocation.args.join(" "), /--user 65532:65532/);
assert.match(invocation.args.join(" "), /--memory 4g --memory-swap 4g/);
assert.match(invocation.args.join(" "), /ai-test-officer\.managed=true/);
assert.match(invocation.args.join(" "), /ai-test-officer\.project-id=demo/);
assert.match(invocation.args.join(" "), /HOST=0\.0\.0\.0/);
assert.match(invocation.args.join(" "), /DATABASE_PATH=\/tmp\/ato-data\/database/);
assert.match(invocation.args.join(" "), /BLOB_STORAGE_PATH=\/tmp\/ato-data\/blob/);
assert.match(invocation.args.join(" "), /mkdir -p \/tmp\/ato-home \/tmp\/ato-data\/database/);
assert.match(invocation.args.join(" "), /find \/workspace -maxdepth 6/);
assert.match(invocation.args.join(" "), /DATABASE_PATH=\/tmp\/ato-data\/database/);
assert.match(invocation.args.join(" "), /UPLOAD_DIR=\/tmp\/ato-data\/uploads/);
assert.match(invocation.args.join(" "), /! -path '\*\/node_modules\/\*'/);
const cachedInvocation = buildOciInvocation({
  engine: "docker",
  image: "node:22",
  manifest,
  repositoryRoot: "/repo",
  prepareCommand: manifest.commands.install,
  command: manifest.commands.start!,
  dependencyCache: {
    key: "lock-hash",
    sourceFingerprint: "source-hash",
    workspaceRoot: "/cache/demo/workspace",
    packageCacheRoot: "/cache/demo/packages"
  }
});
const cachedArgs = cachedInvocation.args.join(" ");
assert.match(cachedArgs, /src=\/cache\/demo\/workspace,dst=\/workspace/);
assert.match(cachedArgs, /src=\/cache\/demo\/packages,dst=\/sandbox-cache/);
assert.match(cachedArgs, /prepared-lock-hash/);
assert.match(cachedArgs, /\.ato-source-source-hash/);
assert.match(cachedArgs, /ATO_SOURCE_CACHE_HIT/);
assert.match(cachedArgs, /ATO_DEPENDENCY_CACHE_HIT/);
assert.match(cachedArgs, /npm_config_prefer_offline=true/);
assert.match(cachedArgs, /GOMODCACHE=\/sandbox-cache\/go\/pkg\/mod/);
assert.match(cachedArgs, /CARGO_TARGET_DIR=\/sandbox-cache\/cargo-target/);
assert.match(cachedArgs, /GRADLE_USER_HOME=\/sandbox-cache\/gradle/);
assert.match(cachedArgs, /MAVEN_OPTS=-Dmaven\.repo\.local=\/sandbox-cache\/maven\/repository/);
assert.match(cachedArgs, /COMPOSER_CACHE_DIR=\/sandbox-cache\/composer-cache/);
assert.match(cachedArgs, /! -name \.venv/);
assert.doesNotMatch(cachedArgs, /\/workspace:rw,exec,nosuid/);
const volumeCachedInvocation = buildOciInvocation({
  engine: "docker",
  image: "node:22",
  manifest,
  repositoryRoot: "/repo",
  prepareCommand: manifest.commands.install,
  command: manifest.commands.start!,
  dependencyCache: {
    key: "lock-hash",
    sourceFingerprint: "source-hash",
    storageMode: "volume",
    workspaceRoot: "/cache/demo/workspace",
    packageCacheRoot: "/cache/demo/packages",
    metadataRoot: "/cache/demo/metadata",
    workspaceVolume: "ato-workspace-demo",
    packageCacheVolume: "ato-packages-demo"
  }
});
const volumeCachedArgs = volumeCachedInvocation.args.join(" ");
assert.match(volumeCachedArgs, /type=volume,src=ato-workspace-demo,dst=\/workspace/);
assert.match(volumeCachedArgs, /type=volume,src=ato-packages-demo,dst=\/sandbox-cache/);
assert.match(volumeCachedArgs, /src=\/cache\/demo\/metadata,dst=\/sandbox-meta/);
assert.match(volumeCachedArgs, /\/sandbox-meta\/prepared-lock-hash/);
assert.doesNotMatch(volumeCachedArgs, /src=\/cache\/demo\/workspace,dst=\/workspace/);
assert.throws(() => buildOciInvocation({
  engine: "docker",
  image: "node:22",
  manifest,
  repositoryRoot: "/repo",
  command: { executable: "bash", args: ["-c", "id"] }
}), /command_not_allowed/);
assert.equal(resolveManifestWorkspace(manifest, "/repo"), "/repo/fixture");
assert.equal(classifyRuntimeFailure(new Error("EADDRINUSE")), "port_conflict");
assert.equal(classifyRuntimeFailure("exit code 1", "code signature not valid; library load disallowed by system policy"), "permission_denied");
assert.equal(classifyRuntimeFailure("exit code 1", "ERR_PNPM_ENOSPC: no space left on device"), "budget_exceeded");
assert.equal(classifyRuntimeFailure("exit code 137", "Killed"), "budget_exceeded");
const tracker = new BudgetTracker({ ...manifest.budget, maxSteps: 1 });
tracker.consume({ steps: 1 });
assert.throws(() => tracker.consume({ steps: 1 }), /budget_exceeded/);
console.log("execution worker tests passed");
