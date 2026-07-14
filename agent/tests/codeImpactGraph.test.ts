import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCodeImpactGraph } from "../src/codeImpactGraph.js";

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
    const cached = await buildCodeImpactGraph({ repositoryRoot: root, files: ["src/pages/orders.ts", "service.py"] });
    assert.equal(cached.cacheHits, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
}
