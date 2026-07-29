import {
  createProjectGrant,
  deleteProjectGrant,
  listProjectGrants
} from "../../projectAccess.js";
import type { ProjectMemberRole } from "../../types.js";

export interface AddProjectMemberInput {
  projectId: string;
  subject: string;
  role: ProjectMemberRole;
  expiresAt?: string;
}

export function readProjectMembers(projectId: string) {
  return listProjectGrants(projectId);
}

export function addProjectMember(input: AddProjectMemberInput) {
  return createProjectGrant(input);
}

export function removeProjectMember(projectId: string, grantId: string) {
  return deleteProjectGrant(projectId, grantId);
}
