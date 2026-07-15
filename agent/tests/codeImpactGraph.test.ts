import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodeImpactGraph, buildDiffImpactGraph, changedFilesFromDiff } from "../src/codeImpactGraph.js";

export async function testCodeImpactGraph() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ato-impact-"));
  try {
    await mkdir(path.join(root, "src", "pages"), { recursive: true });
    await writeFile(path.join(root, "src", "pages", "orders.ts"), `export function loadOrders() { return fetch('/api/orders'); }\napp.get('/api/orders', handler);\n`);
    await writeFile(path.join(root, "service.py"), `@app.get('/api/health')\ndef health():\n    return {'ok': True}\n`);
    const graph = await buildCodeImpactGraph({ repositoryRoot: root, files: ["src/pages/orders.ts", "service.py"], scenarios: [{ id: "orders", keywords: ["orders"] }] });
    assert.ok(graph.nodes.some((node) => node.kind === "symbol" && node.label === "loadOrders"));
    assert.ok(graph.nodes.some((node) => node.kind === "api-route" && node.label === "/api/health"));
    assert.ok(graph.edges.some((edge) => edge.kind === "covered-by"));
    assert.ok(graph.edges.some((edge) => edge.kind === "calls" && edge.reason.includes("resolves to API route")));
    assert.ok(graph.edges.some((edge) => edge.kind === "renders" && edge.reason.includes("contains frontend call")));
    const cached = await buildCodeImpactGraph({ repositoryRoot: root, files: ["src/pages/orders.ts", "service.py"] });
    assert.equal(cached.cacheHits, 2);
    const diff = "diff --git a/src/pages/orders.ts b/src/pages/orders.ts\n+export async function approveOrder() { return fetch('/api/orders/123/approve'); }\n";
    assert.deepEqual(changedFilesFromDiff(diff), ["src/pages/orders.ts"]);
    const patchGraph = buildDiffImpactGraph({ diff, scenarios: [{ id: "approval", keywords: ["approve", "orders"] }] });
    assert.ok(patchGraph.nodes.some((node) => node.kind === "symbol" && node.label === "approveOrder"));
    assert.ok(patchGraph.nodes.some((node) => node.kind === "frontend-call" && node.label.includes("/api/orders")));
    assert.ok(patchGraph.nodes.some((node) => node.kind === "scenario" && node.label === "approval"));
    const merged = await buildCodeImpactGraph({ repositoryRoot: root, files: ["src/pages/orders.ts"], diff, scenarios: [{ id: "approval", keywords: ["approve"] }] });
    assert.ok(merged.explanations.some((reason) => reason.includes("patch signals")));
  } finally { await rm(root, { recursive: true, force: true }); }
}
