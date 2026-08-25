import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { BudgetTracker, buildOciInvocation, buildRunScopedProxyUrl, classifyRuntimeFailure, createEgressNetworkController, createExecutionEnvironment, createIsolatedNetworkController, egressNetworkName, isolatedNetworkName, resolveManifestWorkspace } from "../src/index.js";
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
  network: { mode: "deny" },
  execution: { mode: "trusted-local" }
});
const invocation = buildOciInvocation({
  engine: "docker",
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
const allowlistedManifest = projectManifestSchema.parse({
  ...manifest,
  network: { mode: "allowlist", allowedHosts: ["api.example.com", "127.0.0.1"], enforcement: "external-egress-proxy" }
});
assert.throws(() => buildOciInvocation({
  engine: "docker",
  image: "node:22",
  manifest: allowlistedManifest,
  repositoryRoot: "/repo",
  command: manifest.commands.start!
}), /egress_network_not_configured/);
const previousNetwork = process.env.ATO_EGRESS_NETWORK_NAME;
const previousProxy = process.env.ATO_EGRESS_PROXY_URL;
process.env.ATO_EGRESS_NETWORK_NAME = "ato-egress-test";
process.env.ATO_EGRESS_PROXY_URL = "http://egress-proxy:3128";
const allowlistedInvocation = buildOciInvocation({
  engine: "docker",
  image: "node:22",
  manifest: allowlistedManifest,
  repositoryRoot: "/repo",
  command: manifest.commands.start!
});
const allowlistedArgs = allowlistedInvocation.args.join(" ");
assert.match(allowlistedArgs, /--network ato-egress-test/);
assert.match(allowlistedArgs, /HTTP_PROXY=http:\/\/egress-proxy:3128/);
assert.match(allowlistedArgs, /allowed-hosts=api\.example\.com,127\.0\.0\.1/);
assert.match(allowlistedArgs, /network-policy-sha256=[a-f0-9]{64}/);
assert.equal(egressNetworkName("demo", "run-1"), egressNetworkName("demo", "run-1"));
assert.equal(isolatedNetworkName("demo", "run-1"), isolatedNetworkName("demo", "run-1"));
assert.match(buildRunScopedProxyUrl("http://egress-proxy:3128", { runId: "run-1", attemptId: "attempt-1", policyHash: "a".repeat(64), allowedHosts: ["api.example.com"], secret: "secret" }), /^http:\/\/ato:[^@]+@egress-proxy:3128$/);
const egressCalls: string[][] = [];
const egress = createEgressNetworkController({
  run: async (args) => {
    egressCalls.push(args);
    return { exitCode: args[1] === "inspect" ? 1 : 0 };
  }
});
const egressHandle = await egress.ensure({ projectId: "demo", runId: "run-1", proxyContainer: "ato-egress-proxy" });
assert.equal(egressHandle.created, true);
assert.ok(egressCalls.some((args) => args[1] === "create"));
await egress.teardown(egressHandle);
assert.ok(egressCalls.some((args) => args[1] === "rm"));
const isolatedCalls: string[][] = [];
const isolated = createIsolatedNetworkController({
  run: async (args) => {
    isolatedCalls.push(args);
    return { exitCode: args[1] === "inspect" ? 1 : 0 };
  }
});
const isolatedHandle = await isolated.ensure({ projectId: "demo", runId: "run-1", policyHash: "b".repeat(64) });
assert.equal(isolatedHandle.created, true);
const isolatedCreate = isolatedCalls.find((args) => args[1] === "create") ?? [];
assert.ok(isolatedCreate.includes("--internal"));
assert.ok(isolatedCreate.includes("ai-test-officer.network-mode=deny"));
await isolated.teardown(isolatedHandle);
assert.ok(isolatedCalls.some((args) => args[1] === "rm"));
const isolatedInvocation = buildOciInvocation({
  engine: "docker",
  image: "node:22",
  manifest,
  repositoryRoot: "/repo",
  command: manifest.commands.start!,
  networkName: isolatedHandle.name
});
assert.match(isolatedInvocation.args.join(" "), new RegExp(`--network ${isolatedHandle.name}`));
assert.throws(() => buildOciInvocation({
  engine: "docker",
  image: "node:22",
  manifest,
  repositoryRoot: "/repo",
  command: manifest.commands.start!,
  networkName: "bridge"
}), /isolated_network_not_configured/);
if (previousNetwork === undefined) delete process.env.ATO_EGRESS_NETWORK_NAME;
else process.env.ATO_EGRESS_NETWORK_NAME = previousNetwork;
if (previousProxy === undefined) delete process.env.ATO_EGRESS_PROXY_URL;
else process.env.ATO_EGRESS_PROXY_URL = previousProxy;
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
assert.match(cachedArgs, /ATO_DEPENDENCY_CACHE_RELINK/);
const shellFlagIndex = cachedInvocation.args.lastIndexOf("-c");
assert.ok(shellFlagIndex >= 0);
const shellSyntax = spawnSync("/bin/sh", ["-n"], {
  input: cachedInvocation.args[shellFlagIndex + 1],
  encoding: "utf8"
});
assert.equal(shellSyntax.status, 0, shellSyntax.stderr);
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
const parallelInvocation = buildOciInvocation({
  engine: "docker",
  image: "node:22",
  manifest,
  repositoryRoot: "/repo",
  command: { executable: "npm", args: ["run", "dev", "--parallel"] },
  portBindings: [
    { hostPort: 5173, containerPort: 5173 },
    { hostPort: 3000, containerPort: 3000 }
  ]
});
assert.match(parallelInvocation.args.join(" "), /--cpus 3 --memory 6g --memory-swap 6g --pids-limit 384/);
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
const lifecycle: string[] = [];
const environment = createExecutionEnvironment({
  prepare: async () => { lifecycle.push("prepare"); return { projectId: "lifecycle", status: "ready", generatedAt: new Date().toISOString(), checks: [] }; },
  launchTarget: async () => { lifecycle.push("target"); return { id: "target" }; },
  launchBrowser: async () => { lifecycle.push("browser"); return { id: "browser" }; },
  collectArtifacts: async () => { lifecycle.push("artifacts"); return [{ id: "evidence" }]; },
  teardown: async () => { lifecycle.push("teardown"); }
});
await environment.prepare();
await environment.prepare();
await environment.collectArtifacts();
await Promise.all([environment.teardown(), environment.teardown()]);
assert.deepEqual(lifecycle, ["prepare", "target", "browser", "artifacts", "teardown"], "execution environment must own one ordered, idempotent lifecycle");

// preinstalledDependencies: copy node_modules into the workspace (do NOT
// exclude it) and skip the prepare (install) command so a project whose host
// node_modules is already populated starts without any registry egress.
const preinstalledManifest = projectManifestSchema.parse({
  schemaVersion: "1.0",
  projectId: "demo-preinstalled",
  workspaceRoot: "fixture",
  commandAllowlist: ["npm"],
  commands: { install: { executable: "npm", args: ["ci"] }, start: { executable: "npm", args: ["run", "dev"] } },
  network: { mode: "deny" },
  execution: { mode: "oci", image: "node:22", preinstalledDependencies: true }
});
const preinstalledInvocation = buildOciInvocation({
  engine: "docker", image: "node:22", manifest: preinstalledManifest, repositoryRoot: "/repo",
  prepareCommand: preinstalledManifest.commands.install,
  command: preinstalledManifest.commands.start!,
  portBindings: [{ hostPort: 5173, containerPort: 5173 }]
});
const preinstalledArgs = preinstalledInvocation.args.join(" ");
assert.match(preinstalledArgs, /ATO_PREINSTALLED_DEPENDENCIES_SKIP_INSTALL/, "preinstalled deps must skip the install command");
assert.match(preinstalledArgs, /--exclude=node_modules/, "preinstalled deps exclude node_modules from the tmpfs copy (bind-mounted instead)");
assert.match(preinstalledArgs, /dst=\/workspace\/node_modules/, "preinstalled deps bind-mount node_modules (avoid copying multi-GB deps into the RAM-backed tmpfs, which OOM-kills the sandbox)");
assert.match(preinstalledArgs, /--exclude=\.git --exclude=\.\/dist --exclude=\.\/build/, "preinstalled deps still excludes top-level .git/dist/build (anchored so node_modules/*/dist binaries survive)");
// Contrast: the default (no preinstalled) still excludes node_modules + runs install.
assert.match(invocation.args.join(" "), /--exclude=node_modules/, "default mode excludes node_modules (forces workspace install)");

console.log("execution worker tests passed");
