import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export async function testProductionAcceptanceContract() {
  const compose = await readFile(path.join(rootDir, "deploy", "production-acceptance", "compose.yml"), "utf8");
  for (const service of ["postgres:", "redis:", "minio:", "keycloak:", "agent-api:", "worker:", "todo-lite:", "order-portal-lite:", "customer-portal-lite:"]) assert.match(compose, new RegExp(`^  ${service}`, "m"));
  assert.match(compose, /NODE_ENV: production/);
  assert.match(compose, /DATABASE_URL:/);
  assert.match(compose, /REDIS_URL:/);
  assert.match(compose, /ARTIFACT_S3_BUCKET:/);
  assert.match(compose, /OIDC_ISSUER:/);
  assert.doesNotMatch(compose, /AGENT_API_TOKEN:/);
  const dockerignore = await readFile(path.join(rootDir, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^evaluation$/m);
}
