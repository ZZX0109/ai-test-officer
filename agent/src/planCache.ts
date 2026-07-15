import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { compiledPlanSchema, type CompiledPlan } from "@ai-test-officer/contracts";
import type { GrayPlan } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const cacheDir = path.join(rootDir, "reports", "plan-cache");

export interface CachedPlan {
  key: string;
  plan: GrayPlan;
  compiledPlan: CompiledPlan;
  scenarioId: string;
  model: string;
  originLlmCallId: string;
  createdAt: string;
}

export function planCacheKey(input: { projectId?: string; targetVersion?: string; requirement?: string; diff?: string; promptVersion: string; modelProfileId?: string }) {
  return createHash("sha256").update(JSON.stringify({
    projectId: input.projectId ?? "direct-url",
    targetVersion: input.targetVersion ?? "diff-addressed",
    requirement: input.requirement ?? "",
    diff: input.diff ?? "",
    promptVersion: input.promptVersion,
    modelProfileId: input.modelProfileId ?? ""
  })).digest("hex");
}

export async function readCachedPlan(key: string): Promise<CachedPlan | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(cacheDir, `${key}.json`), "utf8")) as CachedPlan;
    if (value.key !== key || !value.plan?.sessionName || !value.scenarioId || !value.model || !value.originLlmCallId) return undefined;
    return { ...value, compiledPlan: compiledPlanSchema.parse(value.compiledPlan) };
  } catch {
    return undefined;
  }
}

export async function writeCachedPlan(value: CachedPlan) {
  await mkdir(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `${value.key}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, target);
}
