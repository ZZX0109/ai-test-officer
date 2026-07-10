import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CiGatePolicy, CiFlakyMode } from "./ciContract.js";

const defaultGateConfigFile = "ai-test-officer.gate.json";

interface ReadCiGatePolicyInput {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

function parseGateConfig(file: string): Partial<CiGatePolicy> {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`CI gate config must be a JSON object: ${file}`);
  }
  return parsed as Partial<CiGatePolicy>;
}

function normalizeFlakyMode(value: unknown, file: string | undefined): CiFlakyMode {
  if (value === undefined) return "warn";
  if (value === "warn" || value === "fail") return value;
  throw new Error(`Invalid CI gate config flakyMode in ${file ?? defaultGateConfigFile}: expected "warn" or "fail".`);
}

export function readCiGatePolicy(input: ReadCiGatePolicyInput): CiGatePolicy {
  const env = input.env ?? process.env;
  const configPath = path.resolve(input.configPath ?? env.CI_GATE_CONFIG ?? path.join(input.rootDir, defaultGateConfigFile));
  const fromFile = existsSync(configPath) ? parseGateConfig(configPath) : {};
  return {
    strictGate: env.STRICT_RELEASE_GATE === "1" || fromFile.strictGate === true,
    quarantinedScenarios: Array.isArray(fromFile.quarantinedScenarios)
      ? fromFile.quarantinedScenarios
        .map((item) => typeof item === "string" ? item.trim() : "")
        .filter(Boolean)
      : [],
    flakyMode: normalizeFlakyMode(fromFile.flakyMode, existsSync(configPath) ? configPath : undefined)
  };
}
