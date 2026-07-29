import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { environmentForNode, resolveSupportedNode } from "./node-runtime.mjs";

const scriptName = process.argv[2];
if (!scriptName) {
  throw new Error("missing_internal_script: pass the package script to execute");
}

const supportedNode = resolveSupportedNode();
const npmExecutable = path.join(
  path.dirname(supportedNode.binary),
  process.platform === "win32" ? "npm.cmd" : "npm"
);
const child = spawnSync(npmExecutable, ["run", scriptName, "--", ...process.argv.slice(3)], {
  cwd: process.cwd(),
  env: environmentForNode(supportedNode.binary),
  stdio: "inherit"
});

if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
