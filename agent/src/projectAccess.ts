import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type {
  LegacyProjectMemberRole,
  ProjectGrant,
  ProjectMemberRole,
  ProjectScope
} from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const grantDir = path.join(rootDir, "reports", "security");
const grantFile = path.join(grantDir, "project-grants.json");
let postgresPool: Pool | undefined;
let localGrantMutation: Promise<void> = Promise.resolve();

function pool() {
  if (!process.env.DATABASE_URL) return undefined;
  postgresPool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return postgresPool;
}

type StoredProjectGrant = Omit<ProjectGrant, "role"> & {
  role: ProjectMemberRole | LegacyProjectMemberRole;
};

const ROLE_SCOPES: Record<ProjectMemberRole, ProjectScope[]> = {
  viewer: ["read_project", "read_artifacts", "read_reports", "read_evidence"],
  editor: [
    "read_project",
    "read_artifacts",
    "read_reports",
    "read_evidence",
    "run_tests",
    "edit_project",
    "edit_sandbox"
  ],
  owner: [
    "read_project",
    "read_artifacts",
    "read_reports",
    "read_evidence",
    "run_tests",
    "edit_project",
    "edit_sandbox",
    "export_source",
    "apply_source",
    "manage_project",
    "manage_members",
    "manage_credentials",
    "admin"
  ]
};

export function normalizeProjectRole(role: ProjectMemberRole | LegacyProjectMemberRole): ProjectMemberRole {
  if (role === "viewer") return "viewer";
  if (role === "runner" || role === "maintainer" || role === "editor") return "editor";
  return "owner";
}

export function scopesForProjectRole(role: ProjectMemberRole): ProjectScope[] {
  return [...ROLE_SCOPES[role]];
}

export function projectScopeForOperation(input: { method: string; path: string }): ProjectScope {
  const suffix = input.path.replace(/^\/+/, "");
  if (suffix === "grants" || suffix.startsWith("grants/")) return "manage_members";
  if (suffix === "login-credential" || suffix === "api-credential-binding") return "manage_credentials";
  if (input.method === "GET" || input.method === "HEAD") return "read_project";
  if (input.method === "PATCH" || input.method === "PUT") return "edit_project";
  if (input.method === "DELETE") return "manage_project";
  return "run_tests";
}

function tokenKindForRole(role: ProjectMemberRole): ProjectGrant["tokenKind"] {
  if (role === "viewer") return "artifact_read";
  if (role === "owner") return "project_admin";
  return "dev";
}

function normalizeStoredGrant(grant: StoredProjectGrant): ProjectGrant {
  const role = normalizeProjectRole(grant.role);
  return {
    ...grant,
    role,
    tokenKind: tokenKindForRole(role),
    // The role matrix is authoritative; persisted arbitrary scopes must not
    // turn a viewer into an editor.
    scopes: scopesForProjectRole(role)
  };
}

async function readGrants(): Promise<ProjectGrant[]> {
  try {
    return (JSON.parse(await readFile(grantFile, "utf8")) as StoredProjectGrant[]).map(normalizeStoredGrant);
  } catch {
    return [];
  }
}

async function writeGrants(grants: ProjectGrant[]) {
  await mkdir(grantDir, { recursive: true });
  await writeFile(grantFile, JSON.stringify(grants.slice(-500), null, 2));
}

async function mutateLocalGrants<T>(mutation: (grants: ProjectGrant[]) => Promise<{ grants: ProjectGrant[]; result: T }>) {
  let output: T | undefined;
  let failure: unknown;
  localGrantMutation = localGrantMutation.then(async () => {
    try {
      const current = await readGrants();
      const next = await mutation(current);
      await writeGrants(next.grants);
      output = next.result;
    } catch (error) {
      failure = error;
    }
  });
  await localGrantMutation;
  if (failure) throw failure;
  return output as T;
}

export function grantAllows(grant: ProjectGrant, subject: string, scope: ProjectGrant["scopes"][number], now = new Date()) {
  if (grant.subject !== subject || !grant.scopes.includes(scope)) return false;
  return !grant.expiresAt || new Date(grant.expiresAt).getTime() > now.getTime();
}

export async function hasProjectScope(input: { projectId: string; subject: string; scope: ProjectGrant["scopes"][number]; now?: Date }) {
  return (await listProjectGrants(input.projectId)).some((grant) => grantAllows(grant, input.subject, input.scope, input.now));
}

export async function projectAccessDecision(input: {
  projectId: string;
  subject: string;
  scope: ProjectScope;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const grants = (await listProjectGrants(input.projectId)).filter((grant) => (
    grant.subject === input.subject
    && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > now.getTime())
  ));
  return {
    member: grants.length > 0,
    allowed: grants.some((grant) => grant.scopes.includes(input.scope)),
    role: grants[0]?.role
  };
}

export async function listAccessibleProjectIds(subject: string) {
  const now = new Date();
  return [...new Set((await listProjectGrants())
    .filter((grant) => grant.subject === subject && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > now.getTime()))
    .map((grant) => grant.projectId))];
}

export async function listProjectGrants(projectId?: string) {
  const database = pool();
  if (database) {
    const result = await database.query<{ grant_json: ProjectGrant }>(
      `SELECT grant_json FROM project_grants_v1 ${projectId ? "WHERE project_id = $1" : ""} ORDER BY created_at ASC`,
      projectId ? [projectId] : []
    );
    return result.rows.map((row) => normalizeStoredGrant(row.grant_json as StoredProjectGrant));
  }
  const grants = await readGrants();
  return projectId ? grants.filter((grant) => grant.projectId === projectId) : grants;
}

export async function createProjectGrant(input: {
  projectId: string;
  subject: string;
  role: ProjectMemberRole;
  expiresAt?: string;
}) {
  const grant: ProjectGrant = {
    id: `grant_${randomBytes(8).toString("hex")}`,
    projectId: input.projectId,
    subject: input.subject,
    role: input.role,
    tokenKind: tokenKindForRole(input.role),
    scopes: scopesForProjectRole(input.role),
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt
  };
  const database = pool();
  if (database) {
    await database.query(
      "INSERT INTO project_grants_v1 (id, project_id, subject, grant_json, created_at) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (id) DO UPDATE SET grant_json = EXCLUDED.grant_json",
      [grant.id, grant.projectId, grant.subject, JSON.stringify(grant), grant.createdAt]
    );
    return grant;
  }
  return mutateLocalGrants(async (grants) => ({
    grants: [...grants, grant],
    result: grant
  }));
}

export async function deleteProjectGrant(projectId: string, grantId: string) {
  const database = pool();
  if (database) {
    const result = await database.query("DELETE FROM project_grants_v1 WHERE project_id = $1 AND id = $2", [projectId, grantId]);
    return (result.rowCount ?? 0) > 0;
  }
  return mutateLocalGrants(async (grants) => {
    const next = grants.filter((grant) => !(grant.projectId === projectId && grant.id === grantId));
    return { grants: next, result: next.length !== grants.length };
  });
}
