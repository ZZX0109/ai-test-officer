import { createHash } from "node:crypto";
import { z } from "zod";

const scenarioRequestSchema = z.object({
  family: z.string().min(1),
  pagePath: z.string().min(1),
  required: z.boolean().optional()
});

export const onboardingPreviewSchema = z.object({
  project: z.object({ name: z.string().min(1), slug: z.string().optional() }),
  targetApp: z.object({
    name: z.string().min(1),
    defaultMode: z.enum(["scripted", "plan-assisted", "ai-exploratory"]).default("plan-assisted"),
    environments: z.array(z.string()).default([])
  }),
  baseUrl: z.string().url(),
  keyPages: z.array(z.string().min(1)).default([]),
  businessObjective: z.string().min(1),
  selectorHints: z.array(z.string().min(1)).default([]),
  scenarioRequests: z.array(scenarioRequestSchema).default([]),
  accountRef: z.string().optional(),
  auth: z.record(z.unknown()).optional(),
  runtime: z.record(z.unknown()).optional()
});

function slug(value: string) {
  return value.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "target";
}

function stableId(kind: string, value: string) {
  return `${kind}_${slug(value).slice(0, 48)}_${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

export function createMissionPreview(input: unknown) {
  const value = onboardingPreviewSchema.parse(input);
  const timestamp = new Date().toISOString();
  const projectId = stableId("project", value.project.slug ?? value.project.name);
  const targetAppId = stableId("target", `${projectId}:${value.targetApp.name}`);
  const pages = value.keyPages.map((pagePath) => ({
    id: stableId("page", pagePath),
    name: pagePath === "/" ? "Home" : pagePath.split("/").filter(Boolean).join(" / "),
    path: pagePath,
    selectors: value.selectorHints.map((query) => ({ id: stableId("selector", `${pagePath}:${query}`), queries: [query] }))
  }));
  const requests = value.scenarioRequests.length
    ? value.scenarioRequests
    : value.keyPages.map((pagePath) => ({ family: "core-path", pagePath, required: true }));
  const scenarios = requests.map((request, index) => {
    const id = stableId("scenario", `${request.family}:${request.pagePath}:${index}`);
    return {
      id,
      type: "scenario",
      schemaVersion: "2.0",
      family: request.family,
      name: `${request.family} · ${request.pagePath}`,
      pagePath: request.pagePath,
      required: request.required ?? true,
      steps: [
        { id: `${id}_navigate`, action: "navigate", path: request.pagePath },
        { id: `${id}_assert`, action: "assert_page_ready", expected: "document-ready" }
      ]
    };
  });
  const oracles = scenarios.map((scenario) => ({
    id: stableId("oracle", scenario.id),
    type: "oracle",
    schemaVersion: "2.0",
    scenarioId: scenario.id,
    assertions: [{ kind: "page-ready", expected: true }],
    requiredEvidence: ["screenshot", "dom", "trace"]
  }));
  const missionId = stableId("mission", `${projectId}:${value.businessObjective}`);
  return {
    project: { id: projectId, name: value.project.name, status: "active", createdAt: timestamp },
    targetApp: {
      id: targetAppId,
      projectId,
      name: value.targetApp.name,
      baseUrl: value.baseUrl,
      environments: value.targetApp.environments,
      pages,
      auth: value.auth ?? { strategy: value.accountRef ? "session" : "none", accountRef: value.accountRef },
      runtime: value.runtime
    },
    mission: {
      id: missionId,
      projectId,
      targetAppId,
      name: `${value.project.name} quality mission`,
      objective: value.businessObjective,
      mode: value.targetApp.defaultMode,
      status: "ready",
      scenarioIds: scenarios.map(({ id }) => id),
      oracleIds: oracles.map(({ id }) => id)
    },
    scenarios,
    oracles,
    counts: { pages: pages.length, selectorHints: value.selectorHints.length, scenarios: scenarios.length, oracles: oracles.length }
  };
}
