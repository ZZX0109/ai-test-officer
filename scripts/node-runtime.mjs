import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

export const MINIMUM_NODE_MAJOR = 22;
// node:sqlite (used by the Agent state store) only becomes usable without the
// --experimental-sqlite flag from Node 22.5.0. Earlier 22.x releases would pass a
// major-only check but fail at `import { DatabaseSync } from "node:sqlite"`.
export const MINIMUM_NODE_MINOR_FOR_22 = 5;

function nodeVersion(binary) {
  try {
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const match = /^v(\d+)\.(\d+)/.exec(version);
    return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
  } catch {
    return null;
  }
}

function isSupported(version) {
  if (!version) return false;
  if (version.major > MINIMUM_NODE_MAJOR) return true;
  if (version.major === MINIMUM_NODE_MAJOR) {
    return version.minor >= MINIMUM_NODE_MINOR_FOR_22;
  }
  return false;
}

function describeMinimum() {
  return `Node >=${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR_FOR_22} is required because the Agent uses node:sqlite (stable from 22.5).`;
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
    .map((binary) => ({ binary, version: nodeVersion(binary) }))
    .filter((entry) => entry.version);
  const selected = inspected.find(({ version }) => isSupported(version));
  if (!selected) {
    const versions = inspected
      .map(({ binary, version }) => `${binary}=v${version?.major ?? "?"}.${version?.minor ?? "?"}`)
      .join(", ");
    throw new Error(
      `unsupported_node_runtime: ${describeMinimum()} ` +
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
  const [majorRaw, minorRaw] = process.versions.node.split(".");
  const version = { major: Number(majorRaw), minor: Number(minorRaw) };
  if (!isSupported(version)) {
    throw new Error(
      `unsupported_node_runtime: current Node is ${process.version}; ${describeMinimum()}`
    );
  }
}
