import assert from "node:assert/strict";
import {
  createProjectGrant,
  deleteProjectGrant,
  grantAllows,
  normalizeProjectRole,
  projectAccessDecision,
  projectScopeForOperation,
  scopesForProjectRole
} from "../src/projectAccess.js";

export async function testProjectAuthorizationMatrix() {
  const projectId = `project_auth_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const grants = await Promise.all([
    createProjectGrant({ projectId, subject: "owner-user", role: "owner" }),
    createProjectGrant({ projectId, subject: "editor-user", role: "editor" }),
    createProjectGrant({ projectId, subject: "viewer-user", role: "viewer" })
  ]);
  try {
    const expected = {
      owner: {
        read_project: true,
        read_artifacts: true,
        run_tests: true,
        edit_project: true,
        manage_members: true,
        manage_project: true
      },
      editor: {
        read_project: true,
        read_artifacts: true,
        run_tests: true,
        edit_project: true,
        manage_members: false,
        manage_project: false
      },
      viewer: {
        read_project: true,
        read_artifacts: true,
        run_tests: false,
        edit_project: false,
        manage_members: false,
        manage_project: false
      }
    } as const;
    for (const [role, scopes] of Object.entries(expected)) {
      for (const [scope, allowed] of Object.entries(scopes)) {
        const decision = await projectAccessDecision({
          projectId,
          subject: `${role}-user`,
          scope: scope as Parameters<typeof projectAccessDecision>[0]["scope"]
        });
        assert.equal(decision.member, true, `${role} must be a project member`);
        assert.equal(decision.allowed, allowed, `${role}.${scope}`);
      }
    }
    const outsider = await projectAccessDecision({
      projectId,
      subject: "outside-user",
      scope: "read_project"
    });
    assert.deepEqual(outsider, { member: false, allowed: false, role: undefined });

    assert.equal(normalizeProjectRole("runner"), "editor");
    assert.equal(normalizeProjectRole("maintainer"), "editor");
    assert.equal(normalizeProjectRole("project_admin"), "owner");
    assert.equal(scopesForProjectRole("viewer").includes("run_tests"), false);
    assert.equal(projectScopeForOperation({ method: "GET", path: "/" }), "read_project");
    assert.equal(projectScopeForOperation({ method: "PATCH", path: "/" }), "edit_project");
    assert.equal(projectScopeForOperation({ method: "POST", path: "/start" }), "run_tests");
    assert.equal(projectScopeForOperation({ method: "POST", path: "/grants" }), "manage_members");
    assert.equal(projectScopeForOperation({ method: "DELETE", path: "/grants/grant-1" }), "manage_members");
    assert.equal(projectScopeForOperation({ method: "POST", path: "/login-credential" }), "manage_credentials");

    const crossProject = await projectAccessDecision({
      projectId: `${projectId}-other`,
      subject: "owner-user",
      scope: "read_project"
    });
    assert.equal(crossProject.member, false);
    assert.equal(crossProject.allowed, false);

    const expired = {
      ...grants[2],
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    };
    assert.equal(grantAllows(expired, "viewer-user", "read_project"), false);
  } finally {
    await Promise.all(grants.map((grant) => deleteProjectGrant(projectId, grant.id)));
  }
}
