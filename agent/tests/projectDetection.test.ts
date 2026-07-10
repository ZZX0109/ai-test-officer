import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectProject, diagnoseProject } from "../src/projectDetection.js";

async function makeFixture(prefix: string, files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await Promise.all(Object.keys(files).map(async (file) => {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), files[file]);
  }));
  return dir;
}

export async function testProjectDetectionWizard() {
  const fixtures: string[] = [];
  try {
    const vite = await makeFixture("ai-test-officer-vite-", {
      "package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "^5.0.0" } }),
      "package-lock.json": "{}"
    });
    fixtures.push(vite);
    const viteDetection = await detectProject(vite);
    assert.equal(viteDetection.exists, true);
    assert.equal(viteDetection.detectedStack.includes("vite"), true);
    assert.equal(viteDetection.suggestedConfig.processes?.[0]?.command, "npm run dev -- --port 5173");
    assert.equal(viteDetection.plainLanguageFixes.some((fix) => /npm install|项目路径/.test(fix)), true);

    const next = await makeFixture("ai-test-officer-next-", {
      "package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "^14.0.0" } }),
      "next.config.mjs": "export default {};"
    });
    fixtures.push(next);
    const nextDetection = await detectProject(next);
    assert.equal(nextDetection.detectedStack.includes("next"), true);
    assert.equal(nextDetection.suggestedConfig.frontendUrl, "http://127.0.0.1:3000");

    const express = await makeFixture("ai-test-officer-express-", {
      "package.json": JSON.stringify({ scripts: { dev: "node server.js" }, dependencies: { express: "^4.0.0" } })
    });
    fixtures.push(express);
    const expressDetection = await detectProject(express);
    assert.equal(expressDetection.detectedStack.includes("express"), true);
    assert.equal(expressDetection.suggestedConfig.backendUrl, "http://127.0.0.1:3000/api/health");

    const fastapi = await makeFixture("ai-test-officer-fastapi-", {
      "backend/requirements.txt": "fastapi\nuvicorn\n",
      "backend/app.py": "from fastapi import FastAPI\napp = FastAPI()\n"
    });
    fixtures.push(fastapi);
    const fastapiDetection = await detectProject(fastapi);
    assert.equal(fastapiDetection.detectedStack.includes("fastapi"), true);
    assert.equal(fastapiDetection.suggestedConfig.processes?.[0]?.healthCheckUrl, "http://127.0.0.1:8000/api/health");

    const missing = await diagnoseProject("missing_project_detection_selftest");
    assert.equal(missing.overallStatus, "failed");
    assert.equal(missing.stages[0]?.humanMessage.includes("项目配置"), true);
  } finally {
    await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
  }
}
