import { createHash } from "node:crypto";
import type { BusinessPath } from "./businessPathCompiler.js";

export interface RuntimePathObservation {
  url: string;
  method?: string;
  title?: string;
  statusCode?: number;
  source: "browser" | "network" | "manifest";
  evidenceRefs?: string[];
}

export interface MergedBusinessPath extends BusinessPath {
  runtimeObserved: boolean;
  runtimeEvidenceRefs: string[];
  runtimeObservations: RuntimePathObservation[];
}

function route(value: string) {
  return value.replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase() || "/";
}

function key(observation: RuntimePathObservation) {
  return `${(observation.method ?? "GET").toUpperCase()}:${route(observation.url)}`;
}

/**
 * Browser/network capture also includes the dev server, bundled modules and
 * static resources. They are useful to the runtime diagnostician, but they
 * are not customer-facing capabilities and must never become a "business
 * function" in the planning UI.
 */
function isRuntimeInfrastructureObservation(observation: RuntimePathObservation) {
  const path = route(observation.url);
  return path.startsWith("/@fs/")
    || path.startsWith("/@vite/")
    || path.startsWith("/@react-refresh")
    || path.startsWith("/@id/")
    || path.startsWith("/__vite_")
    || path.includes("/node_modules/")
    || path.startsWith("/assets/")
    || /\.(?:avif|bmp|css|eot|gif|ico|jpe?g|js|map|mjs|otf|png|svg|ttf|webp|woff2?)$/i.test(path);
}

export function mergeRuntimeBusinessPaths(paths: BusinessPath[], observations: RuntimePathObservation[]): MergedBusinessPath[] {
  const byKey = new Map<string, RuntimePathObservation[]>();
  for (const observation of observations) {
    if (isRuntimeInfrastructureObservation(observation)) continue;
    byKey.set(key(observation), [...(byKey.get(key(observation)) ?? []), observation]);
  }
  const consumed = new Set<string>();
  const merged = paths.map((path) => {
    const candidates = [...byKey.entries()].filter(([candidate]) => path.summary.toLowerCase().includes(candidate.split(":")[1]) || path.title.toLowerCase().includes(candidate.split(":")[1]));
    const runtime = candidates.flatMap(([, items]) => items);
    for (const item of runtime) consumed.add(key(item));
    return {
      ...path,
      runtimeObserved: runtime.length > 0,
      runtimeEvidenceRefs: [...new Set(runtime.flatMap((item) => item.evidenceRefs ?? []))],
      runtimeObservations: runtime
    } satisfies MergedBusinessPath;
  });
  for (const [candidate, items] of byKey) {
    if (consumed.has(candidate)) continue;
    const first = items[0];
    const id = `business_path_runtime_${createHash("sha256").update(candidate).digest("hex").slice(0, 20)}`;
    merged.push({
      id,
      title: first.title ? `${first.title}（运行时发现）` : `${first.method ?? "GET"} ${route(first.url)}（运行时发现）`,
      summary: `运行时观察到 ${(first.method ?? "GET").toUpperCase()} ${route(first.url)}，尚未在静态业务图中找到对应路径。`,
      status: "needs-input",
      confidence: "low",
      risk: "medium",
      surfaces: ["page"],
      roles: [],
      preconditions: ["确认该动态路径属于目标业务范围"],
      actionCandidates: ["在真实页面重新绑定运行时入口"],
      oracleCandidates: ["补充该路径的预期结果和允许状态码"],
      requiredEvidenceKinds: ["dom", "network", "screenshot"],
      sourceNodeIds: [],
      sourceLocations: [],
      reason: "该路径只由运行时证据发现，不能自动提升为可执行路径。",
      runtimeObserved: true,
      runtimeEvidenceRefs: [...new Set(items.flatMap((item) => item.evidenceRefs ?? []))],
      runtimeObservations: items
    });
  }
  return merged;
}
