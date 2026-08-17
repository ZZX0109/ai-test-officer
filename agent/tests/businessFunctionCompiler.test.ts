import assert from "node:assert/strict";
import { compileBusinessFunctions } from "../src/businessFunctionCompiler.js";
import type { BusinessPath } from "../src/businessPathCompiler.js";

function makePath(input: Partial<BusinessPath> & Pick<BusinessPath, "id" | "title">): BusinessPath {
  return {
    id: input.id,
    title: input.title,
    summary: input.summary ?? input.title,
    status: input.status ?? "auto-bindable",
    confidence: input.confidence ?? "high",
    risk: input.risk ?? "medium",
    surfaces: input.surfaces ?? ["page"],
    roles: input.roles ?? [],
    preconditions: input.preconditions ?? [],
    actionCandidates: input.actionCandidates ?? ["observe-page"],
    oracleCandidates: input.oracleCandidates ?? ["page-ready"],
    requiredEvidenceKinds: input.requiredEvidenceKinds ?? ["screenshot", "dom"],
    sourceNodeIds: input.sourceNodeIds ?? [`node_${input.id}`],
    sourceLocations: input.sourceLocations ?? [{ file: `src/${input.id}.tsx`, line: 10, parser: "test", sourceHash: `hash_${input.id}` }],
    reason: input.reason ?? "source-backed test path"
  };
}

export function testBusinessFunctionCompiler() {
  const result = compileBusinessFunctions({
    projectName: "订单平台",
    snapshotHash: "snapshot-1",
    sourceCandidateCount: 9,
    paths: [
      makePath({ id: "login-page", title: "Login 页面业务流程", roles: ["用户"] }),
      makePath({ id: "login-api", title: "POST /api/login 接口业务流程", surfaces: ["api"], roles: ["用户"] }),
      makePath({ id: "health", title: "GET /health 接口业务流程", surfaces: ["api"] }),
      makePath({ id: "schema", title: "Order 数据验证流程", surfaces: ["data"] }),
      makePath({ id: "shell", title: "Default Redirect 页面业务流程", surfaces: ["page"] }),
      makePath({ id: "unknown", title: "UnknownScreen 页面业务流程", confidence: "low", status: "needs-input" })
    ]
  });

  const login = result.functions.find((item) => item.name === "登录与身份认证");
  assert.ok(login, "page and API paths for login should form one user-facing function");
  assert.deepEqual(new Set(login.pathIds), new Set(["login-page", "login-api"]));
  assert.equal(login.sourceLocations.length, 2);
  assert.equal(login.status, "ready");
  assert.equal(result.overview.businessFunctionCount, result.functions.length);
  assert.equal(result.overview.sourceCandidateCount, 9);
  assert.equal(result.overview.statusCounts.ready, 1);
  assert.equal(result.overview.statusCounts.unknown, 1);
  assert.ok(result.overview.technicalPathCount >= 3, "health, data and shell paths stay internal");
  assert.ok(!result.functions.some((item) => /health|schema|redirect/i.test(item.name)));

  const unknown = result.functions.find((item) => item.pathIds.includes("unknown"));
  assert.equal(unknown?.status, "unknown");
}
