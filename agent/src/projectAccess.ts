import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { ProjectGrant } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const grantDir = path.join(rootDir, "reports", "security");
const grantFile = path.join(grantDir, "project-grants.json");
let postgresPool: Pool | undefined;

function pool() {
  if (!process.env.DATABASE_URL) return undefined;
  postgresPool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return postgresPool;
}

async function readGrants(): Promise<ProjectGrant[]> {
  try {
    return JSON.parse(await readFile(grantFile, "utf8")) as ProjectGrant[];
  } catch {
    return [];
  }
}

async function writeGrants(grants: ProjectGrant[]) {
  await mkdir(grantDir, { recursive: true });
  await writeFile(grantFile, JSON.stringify(grants.slice(-500), null, 2));
}

function scopesForRole(role: ProjectGrant["role"]): ProjectGrant["scopes"] {
  if (role === "viewer") return ["read_project", "read_artifacts"];
  if (role === "runner") return ["read_project", "run_tests", "read_artifacts"];
  if (role === "project_admin") return ["read_project", "run_tests", "read_artifacts", "manage_project"];
  if (role === "operator") return ["read_project", "run_tests", "read_artifacts", "manage_project", "manage_credentials"];
  return ["read_project", "run_tests", "read_artifacts", "manage_project", "manage_credentials", "admin"];
}

function tokenKindForRole(role: ProjectGrant["role"]): ProjectGrant["tokenKind"] {
  if (role === "viewer") return "artifact_read";
  if (role === "project_admin") return "project_admin";
  if (role === "admin" || role === "operator") return "deploy";
  return "dev";
}

export function grantAllows(grant: ProjectGrant, subject: string, scope: ProjectGrant["scopes"][number], now = new Date()) {
  if (grant.subject !== subject || !grant.scopes.includes(scope)) return false;
  return !grant.expiresAt || new Date(grant.expiresAt).getTime() > now.getTime();
}

export async function hasProjectScope(input: { projectId: string; subject: string; scope: ProjectGrant["scopes"][number]; now?: Date }) {
  return (await listProjectGrants(input.projectId)).some((grant) => grantAllows(grant, input.subject, input.scope, input.now));
}

export async function listProjectGrants(projectId?: string) {
  const database = pool();
  if (database) {
    const result = await database.query<{ grant_json: ProjectGrant }>(
      `SELECT grant_json FROM project_grants_v1 ${projectId ? "WHERE project_id = $1" : ""} ORDER BY created_at ASC`,
      projectId ? [projectId] : []
    );
    return result.rows.map((row) => row.grant_json);
  }
  const grants = await readGrants();
  return projectId ? grants.filter((grant) => grant.projectId === projectId) : grants;
}

export async function createProjectGrant(input: {
  projectId: string;
  subject: string;
  role: ProjectGrant["role"];
  expiresAt?: string;
  scopes?: ProjectGrant["scopes"];
}) {
  const grant: ProjectGrant = {
    id: `grant_${randomBytes(8).toString("hex")}`,
    projectId: input.projectId,
    subject: input.subject,
    role: input.role,
    tokenKind: tokenKindForRole(input.role),
    scopes: input.scopes?.length ? input.scopes : scopesForRole(input.role),
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt
  };
  const grants = await readGrants();
  const database = pool();
  if (database) {
    await database.query(
      "INSERT INTO project_grants_v1 (id, project_id, subject, grant_json, created_at) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (id) DO UPDATE SET grant_json = EXCLUDED.grant_json",
      [grant.id, grant.projectId, grant.subject, JSON.stringify(grant), grant.createdAt]
    );
    return grant;
  }
  grants.push(grant);
  await writeGrants(grants);
  return grant;
}

export async function deleteProjectGrant(projectId: string, grantId: string) {
  const database = pool();
  if (database) {
    const result = await database.query("DELETE FROM project_grants_v1 WHERE project_id = $1 AND id = $2", [projectId, grantId]);
    return (result.rowCount ?? 0) > 0;
  }
  const grants = await readGrants();
  const next = grants.filter((grant) => !(grant.projectId === projectId && grant.id === grantId));
  await writeGrants(next);
  return next.length !== grants.length;
}
