import type { ProjectConfig } from "./types.js";

const redactedValue = "[REDACTED]";

/**
 * Build the host environment for a target process from the project registry.
 * Secret files are deliberately not read from the source tree: Repair copies
 * exclude them, and loading an arbitrary source `.env` would let a project
 * silently override the credential/configuration boundary. Redacted values
 * are omitted so an OCI image's safe test defaults or an explicit credential
 * binding can remain authoritative.
 */
export async function readProjectExecutionEnv(project: ProjectConfig) {
  const allowed = new Set(project.manifest?.environmentAllowlist ?? Object.keys(project.env ?? {}));
  return Object.fromEntries(
    Object.entries(project.env ?? {}).filter(([name, value]) => allowed.has(name) && value !== redactedValue)
  );
}
