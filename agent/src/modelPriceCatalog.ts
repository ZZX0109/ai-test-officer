import { readFileSync } from "node:fs";
import path from "node:path";
import { modelPriceCatalogSchema, type ModelPriceCatalog } from "@ai-test-officer/contracts";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
let cached: ModelPriceCatalog | undefined;

export function loadModelPriceCatalog() {
  if (cached) return cached;
  const configured = process.env.MODEL_PRICE_CATALOG_PATH;
  const file = configured ? path.resolve(configured) : path.join(rootDir, "data", "model-prices", "catalog.json");
  cached = modelPriceCatalogSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return cached;
}

export function estimateModelUsageCost(input: {
  provider: string;
  model: string;
  promptTokens?: number;
  cachedPromptTokens?: number;
  completionTokens?: number;
}) {
  const catalog = loadModelPriceCatalog();
  const entry = catalog.entries.find((candidate) => {
    if (candidate.provider !== input.provider) return false;
    try {
      return new RegExp(candidate.modelPattern).test(input.model);
    } catch {
      return candidate.modelPattern === input.model;
    }
  });
  if (!entry || (input.promptTokens === undefined && input.completionTokens === undefined)) {
    return { cost: null, catalogVersion: catalog.version };
  }
  const cached = Math.min(input.cachedPromptTokens ?? 0, input.promptTokens ?? 0);
  const uncached = Math.max(0, (input.promptTokens ?? 0) - cached);
  const inputCost = uncached * entry.inputPerMillion / 1_000_000;
  const cachedCost = cached * (entry.cachedInputPerMillion ?? entry.inputPerMillion) / 1_000_000;
  const outputCost = (input.completionTokens ?? 0) * entry.outputPerMillion / 1_000_000;
  return { cost: inputCost + cachedCost + outputCost, catalogVersion: catalog.version };
}

export function resetModelPriceCatalogForTests() {
  cached = undefined;
}
