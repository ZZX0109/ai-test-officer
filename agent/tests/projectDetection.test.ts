import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectProject, detectProjectManifest, diagnoseProject } from "../src/projectDetection.js";

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
      "package-lock.json": "{}",
      "openapi.json": JSON.stringify({
        openapi: "3.1.0",
        paths: {
          "/api/tasks": { get: { operationId: "listTasks", responses: { "200": {} } } },
          "/api/tasks/{id}": { delete: { operationId: "deleteTask", responses: { "204": {} } } }
        }
      })
    });
    fixtures.push(vite);
    const viteDetection = await detectProject(vite);
    assert.equal(viteDetection.exists, true);
    assert.equal(viteDetection.loginCapability?.detected, false);
    assert.equal(viteDetection.detectedStack.includes("vite"), true);
    assert.equal(viteDetection.suggestedConfig.installCommand, "npm ci");
    assert.equal(viteDetection.suggestedConfig.processes?.[0]?.command, "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort");
    assert.equal(viteDetection.suggestedConfig.processes?.[0]?.commandSpec?.executable, "npm");
    assert.equal(viteDetection.suggestedConfig.manifest?.execution.mode, "oci");
    assert.equal(viteDetection.suggestedConfig.manifest?.execution.image, "node:22-bookworm-slim");
    assert.equal(viteDetection.suggestedConfig.manifest?.workspaceRoot, ".");
    assert.deepEqual(
      viteDetection.suggestedConfig.manifest?.apiOperations.map((item) => [item.operationId, item.destructive]),
      [["listTasks", false], ["deleteTask", true]]
    );
    assert.equal(viteDetection.plainLanguageFixes.some((fix) => /npm install|项目路径/.test(fix)), true);

    const viteCustomPort = await makeFixture("ai-test-officer-vite-port-", {
      "package.json": JSON.stringify({ scripts: { dev: "vite" }, dependencies: { vite: "^5.0.0" } }),
      "package-lock.json": "{}",
      "vite.config.ts": "export default { server: {\n  port: 5448,\n} };"
    });
    fixtures.push(viteCustomPort);
    const viteCustomPortDetection = await detectProject(viteCustomPort);
    assert.equal(viteCustomPortDetection.suggestedConfig.frontendUrl, "http://127.0.0.1:5448");
    assert.equal(viteCustomPortDetection.suggestedConfig.processes?.[0]?.command, "npm run dev -- --host 0.0.0.0 --port 5448 --strictPort");

    const next = await makeFixture("ai-test-officer-next-", {
      "package.json": JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "^14.0.0" } }),
      "next.config.mjs": "export default {};"
    });
    fixtures.push(next);
    const nextDetection = await detectProject(next);
    assert.equal(nextDetection.detectedStack.includes("next"), true);
    assert.equal(nextDetection.suggestedConfig.frontendUrl, "http://127.0.0.1:3000");
    assert.equal(nextDetection.suggestedConfig.installCommand, "npm install");

    const goWeb = await makeFixture("ai-test-officer-go-", {
      "go.mod": "module example.test/web\n\ngo 1.23\n",
      "main.go": "package main\nfunc main() {}\n"
    });
    fixtures.push(goWeb);
    const goDetection = await detectProject(goWeb);
    assert.equal(goDetection.detectedStack.includes("go"), true);
    assert.equal(goDetection.suggestedConfig.processes?.[0]?.command, "go run .");
    assert.equal(goDetection.suggestedConfig.manifest?.execution.image, "golang:1.23-bookworm");
    assert.deepEqual(goDetection.suggestedConfig.manifest?.commandAllowlist, ["go"]);

    const staticWeb = await makeFixture("ai-test-officer-static-", {
      "index.html": "<!doctype html><title>Static fixture</title>"
    });
    fixtures.push(staticWeb);
    const staticDetection = await detectProject(staticWeb);
    assert.equal(staticDetection.detectedStack.includes("static"), true);
    assert.equal(staticDetection.suggestedConfig.processes?.[0]?.command, "python3 -m http.server 4173 --bind 0.0.0.0");
    assert.equal(staticDetection.suggestedConfig.manifest?.execution.image, "python:3.12-slim-bookworm");

    const pnpmWorkspace = await makeFixture("ai-test-officer-pnpm-workspace-", {
      "package.json": JSON.stringify({
        private: true,
        workspaces: ["packages/*"],
        scripts: { dev: "turbo run dev", test: "turbo run test" }
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "packages/server/package.json": JSON.stringify({
        name: "@fixture/server",
        scripts: { dev: "node src/server.js" },
        dependencies: { express: "^4.0.0" }
      }),
      "packages/server/.env": "PORT=3456\nDATABASE_PATH=/Users/developer/project/data\n",
      "packages/server/src/server.js": "app.get('/api/v1/health', (_req, res) => res.json({ ok: true }))",
      "packages/dashboard/package.json": JSON.stringify({
        name: "@fixture/dashboard",
        scripts: { dev: "vite" },
        devDependencies: { vite: "^5.0.0", react: "^18.0.0" }
      }),
      "packages/dashboard/vite.config.ts": "export default { server: { port: 6123 } };"
    });
    fixtures.push(pnpmWorkspace);
    const pnpmWorkspaceDetection = await detectProject(pnpmWorkspace);
    assert.equal(pnpmWorkspaceDetection.detectedStack.includes("vite"), true);
    assert.equal(pnpmWorkspaceDetection.suggestedConfig.frontendUrl, "http://127.0.0.1:6123");
    assert.equal(
      pnpmWorkspaceDetection.suggestedConfig.processes?.[0]?.command,
      "pnpm --parallel --filter @fixture/server --filter @fixture/dashboard run dev"
    );
    assert.equal(pnpmWorkspaceDetection.suggestedConfig.processes?.length, 1);
    assert.equal(pnpmWorkspaceDetection.suggestedConfig.backendUrl, "http://127.0.0.1:3456/api/v1/health");
    assert.equal(pnpmWorkspaceDetection.suggestedConfig.manifest?.ports.some((item) => item.purpose === "backend"), true);
    assert.equal(
      pnpmWorkspaceDetection.suggestedConfig.installCommand,
      "pnpm --filter @fixture/server... --filter @fixture/dashboard... install --frozen-lockfile"
    );
    assert.equal(pnpmWorkspaceDetection.suggestedConfig.testCommand, "pnpm run test");
    assert.equal(pnpmWorkspaceDetection.suggestedConfig.testCommandSpec?.executable, "pnpm");
    assert.deepEqual(pnpmWorkspaceDetection.suggestedConfig.manifest?.commands.test?.args, ["run", "test"]);

    const npmWorkspace = await makeFixture("ai-test-officer-npm-workspace-", {
      "package.json": JSON.stringify({ private: true, workspaces: ["apps/*"] }),
      "package-lock.json": "{}",
      "apps/web/package.json": JSON.stringify({
        name: "@fixture/web",
        scripts: { dev: "vite" },
        devDependencies: { vite: "^5.0.0", react: "^18.0.0" }
      })
    });
    fixtures.push(npmWorkspace);
    const npmWorkspaceDetection = await detectProject(npmWorkspace);
    assert.equal(
      npmWorkspaceDetection.suggestedConfig.processes?.[0]?.command,
      "npm --workspace @fixture/web run dev -- --host 0.0.0.0 --port 5173 --strictPort"
    );

    const authenticatedApp = await makeFixture("ai-test-officer-auth-", {
      "package.json": JSON.stringify({
        scripts: { dev: "vite" },
        dependencies: { vite: "^5.0.0", "@supabase/supabase-js": "^2.0.0" }
      }),
      "src/pages/login.tsx": "export function Login() { return <form>Login</form>; }"
    });
    fixtures.push(authenticatedApp);
    const authenticatedDetection = await detectProject(authenticatedApp);
    assert.equal(authenticatedDetection.loginCapability?.detected, true);
    assert.equal(authenticatedDetection.loginCapability?.confidence, "high");

    const dataOnlySupabaseApp = await makeFixture("ai-test-officer-supabase-data-", {
      "package.json": JSON.stringify({
        scripts: { dev: "vite" },
        dependencies: { vite: "^5.0.0", "@supabase/supabase-js": "^2.0.0" }
      }),
      "src/data.ts": "export const loadRows = () => fetch('/api/rows');"
    });
    fixtures.push(dataOnlySupabaseApp);
    const dataOnlySupabaseDetection = await detectProject(dataOnlySupabaseApp);
    assert.equal(dataOnlySupabaseDetection.loginCapability?.detected, false);
    assert.equal(dataOnlySupabaseDetection.loginCapability?.signals.includes("dependency:@supabase/supabase-js"), true);

    const apiBackedApp = await makeFixture("ai-test-officer-api-credential-", {
      "package.json": JSON.stringify({
        scripts: { dev: "vite" },
        dependencies: { vite: "^5.0.0" }
      }),
      ".env.example": "OPENAI_API_KEY=\nOPENAI_BASE_URL=https://api.example.test/v1\n",
      "src/server.ts": "const key = process.env.OPENAI_API_KEY; export { key };",
      "src/client.ts": "const key = import.meta.env.VITE_DEMO_API_KEY; export { key };"
    });
    fixtures.push(apiBackedApp);
    const apiCredentialDetection = await detectProject(apiBackedApp);
    assert.equal(apiCredentialDetection.apiCredentialCapability?.detected, true);
    assert.deepEqual(
      apiCredentialDetection.apiCredentialCapability?.requirements.map((item) => item.envName).sort(),
      ["OPENAI_API_KEY", "VITE_DEMO_API_KEY"]
    );
    assert.equal(
      apiCredentialDetection.apiCredentialCapability?.requirements.find((item) => item.envName === "VITE_DEMO_API_KEY")?.exposure,
      "browser"
    );
    assert.equal(
      apiCredentialDetection.suggestedConfig.manifest?.environmentAllowlist.includes("OPENAI_API_KEY"),
      true
    );
    assert.deepEqual(apiCredentialDetection.suggestedConfig.apiCredentialBindings, []);

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

    const browserManifestDetection = await detectProjectManifest({
      rootName: "browser-selected-vite",
      files: [
        {
          relativePath: "browser-selected-vite/package.json",
          content: JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^7.0.0" } })
        },
        {
          relativePath: "browser-selected-vite/vite.config.ts",
          content: "export default { server: {\n  port: 5448,\n} };"
        },
        {
          relativePath: "browser-selected-vite/openapi.json",
          content: JSON.stringify({
            openapi: "3.1.0",
            paths: { "/api/health": { get: { operationId: "health", responses: { "200": {} } } } }
          })
        },
        { relativePath: "browser-selected-vite/src/pages/login.tsx", content: "export const Login = () => null;" },
        { relativePath: "browser-selected-vite/package-lock.json" }
      ]
    });
    assert.equal(browserManifestDetection.exists, true);
    assert.equal(browserManifestDetection.detectionSource, "browser-manifest");
    assert.equal(browserManifestDetection.executionReady, false);
    assert.equal(browserManifestDetection.detectedStack.includes("vite"), true);
    assert.equal(browserManifestDetection.suggestedConfig.installCommand, "npm ci");
    assert.equal(browserManifestDetection.suggestedConfig.frontendUrl, "http://127.0.0.1:5448");
    assert.equal(browserManifestDetection.suggestedConfig.manifest?.execution.mode, "oci");
    assert.equal(browserManifestDetection.suggestedConfig.manifest?.apiOperations[0]?.operationId, "health");
    assert.equal(browserManifestDetection.loginCapability?.detected, true);
    assert.equal(browserManifestDetection.warnings.some((warning) => warning.includes("完整路径")), true);

    const missing = await diagnoseProject("missing_project_detection_selftest");
    assert.equal(missing.overallStatus, "failed");
    assert.equal(missing.stages[0]?.humanMessage.includes("项目配置"), true);
  } finally {
    await Promise.all(fixtures.map((fixture) => rm(fixture, { recursive: true, force: true })));
  }
}
