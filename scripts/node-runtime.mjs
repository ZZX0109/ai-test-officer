import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

export const MINIMUM_NODE_MAJOR = 22;

function nodeMajor(binary) {
  try {
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const match = /^v(\d+)/.exec(version);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function executable(binary) {
  try {
    accessSync(binary, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates() {
  const candidates = [];
  for (const directory of String(process.env.PATH ?? "").split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, "node"));
  }
  candidates.push(
    process.execPath,
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    "/opt/homebrew/opt/node/bin/node"
  );
  return [...new Set(candidates)];
}

export function resolveSupportedNode() {
  const inspected = pathCandidates()
    .filter(executable)
    .map((binary) => ({ binary, major: nodeMajor(binary) }));
  const selected = inspected.find(({ major }) => major >= MINIMUM_NODE_MAJOR);
  if (!selected) {
    const versions = inspected.map(({ binary, major }) => `${binary}=v${major || "unknown"}`).join(", ");
    throw new Error(
      `unsupported_node_runtime: Node >=${MINIMUM_NODE_MAJOR} is required because the Agent uses node:sqlite. ` +
      `Detected ${versions || "no executable Node runtime"}.`
    );
  }
  return selected;
}

export function environmentForNode(binary, environment = process.env) {
  const directory = path.dirname(binary);
  const pathEntries = String(environment.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && entry !== directory);
  return {
    ...environment,
    PATH: [directory, ...pathEntries].join(path.delimiter),
    AI_TEST_OFFICER_NODE_BINARY: binary
  };
}

export function assertCurrentNodeSupported() {
  const currentMajor = Number(process.versions.node.split(".")[0]);
  if (currentMajor < MINIMUM_NODE_MAJOR) {
    throw new Error(
      `unsupported_node_runtime: current Node is ${process.version}; Node >=${MINIMUM_NODE_MAJOR} is required.`
    );
  }
}
