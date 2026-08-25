import type { CoverageItem } from "@ai-test-officer/contracts";

export const runtimeBindingCompilerVersion = "runtime-binding-v1";

export type RuntimeBindingStatus = NonNullable<CoverageItem["binding"]>["status"];

export function dynamicBrowserBinding(input: {
  pathId: string;
  surface: CoverageItem["surface"];
  status?: "executable" | "auto-bindable" | "needs-input" | "coverage-gap";
  route?: string;
  reason?: string;
  requiredEvidenceKinds?: string[];
}) {
  const status: RuntimeBindingStatus = input.status === "needs-input"
    ? "needs-input"
    : input.status === "coverage-gap"
      ? "coverage-gap"
      : input.surface === "page"
        ? "pending"
        : "coverage-gap";
  return {
    compilerVersion: runtimeBindingCompilerVersion,
    status,
    ...(input.route ? { entryRoute: input.route } : {}),
    actionPathIds: [input.pathId],
    oracleIds: [],
    requiredCapabilities: input.surface === "page" ? ["browserControl"] : [],
    ...(input.reason ? { reason: input.reason } : {})
  } satisfies NonNullable<CoverageItem["binding"]>;
}

export function manifestBinding(input: {
  surface: CoverageItem["surface"];
  flowId: string;
  operationId?: string;
  route?: string;
  oracleIds: string[];
  blockedReason?: string;
}) {
  const status: RuntimeBindingStatus = input.blockedReason
    ? input.surface === "page" ? "coverage-gap" : "blocked-by-capability"
    : "bound";
  const requiredCapabilities = input.surface === "page"
    ? ["browserControl"]
    : input.surface === "data" ? ["dataRead"] : ["targetNetwork"];
  return {
    compilerVersion: runtimeBindingCompilerVersion,
    status,
    ...(input.route ? { entryRoute: input.route } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    actionPathIds: [input.flowId],
    oracleIds: input.oracleIds,
    requiredCapabilities,
    ...(input.blockedReason ? { reason: input.blockedReason } : {}),
    ...(!input.blockedReason ? { boundAt: new Date().toISOString() } : {})
  } satisfies NonNullable<CoverageItem["binding"]>;
}
