import type {
  ProjectConfig,
  ProjectHealthCheckResult,
  ProjectLoginConfig,
  ProjectRuntimeFailureReason
} from "./types.js";

export async function checkProjectUrl(url: string | undefined, timeoutMs: number) {
  if (!url) return undefined;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, status: response.status, url };
  } catch (error) {
    return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
  }
}

export function projectHealthReason(input: {
  pathOk: boolean;
  credentialOk: boolean;
  frontend?: { ok: boolean };
  backend?: { ok: boolean };
  health?: { ok: boolean };
  processHealth?: Array<{ required: boolean; ok: boolean }>;
}): ProjectRuntimeFailureReason {
  if (!input.pathOk) return "project_path_missing";
  if (!input.credentialOk) return "credential_missing";
  if (input.processHealth?.some((item) => item.required && !item.ok)) return "health_timeout";
  if (input.health && !input.health.ok) return "health_timeout";
  if (input.frontend && !input.frontend.ok) return "frontend_unreachable";
  if (input.backend && !input.backend.ok) return "backend_unreachable";
  return "none";
}

function hasEnvValue(name: string | undefined) {
  return Boolean(name?.trim() && process.env[name.trim()]?.trim());
}

export function checkProjectCredential(login: ProjectLoginConfig | undefined, projectSecretResolved = false): ProjectHealthCheckResult["credential"] {
  if (!login || login.method === "none") {
    return { ok: true, method: "none", missingEnv: [] };
  }
  if (login.credentialId?.trim()) {
    if (login.credentialId.startsWith("login_") && !projectSecretResolved) {
      return {
        ok: false,
        method: login.method,
        credentialId: login.credentialId,
        missingEnv: ["encrypted project login credential"]
      };
    }
    return { ok: true, method: login.method, credentialId: login.credentialId, missingEnv: [] };
  }
  const requiredEnv = [login.usernameEnv, login.passwordEnv]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  const missingEnv = requiredEnv.filter((name) => !hasEnvValue(name));
  const missingConfiguredNames = [
    login.usernameEnv?.trim() ? undefined : "usernameEnv",
    login.passwordEnv?.trim() ? undefined : "passwordEnv"
  ].filter((item): item is string => Boolean(item));
  return {
    ok: missingEnv.length === 0 && missingConfiguredNames.length === 0,
    method: login.method,
    missingEnv: [...missingConfiguredNames, ...missingEnv]
  };
}

export function checkProjectApiCredentials(project: ProjectConfig, resolvedCredentialIds: Set<string>): ProjectHealthCheckResult["apiCredential"] {
  const requirements = project.apiCredentialRequirements ?? [];
  const bindings = new Map((project.apiCredentialBindings ?? []).map((binding) => [binding.envName, binding]));
  const status = requirements.map((requirement) => {
    const binding = bindings.get(requirement.envName);
    return {
      envName: requirement.envName,
      configured: Boolean(binding && resolvedCredentialIds.has(binding.credentialId)),
      credentialId: binding?.credentialId,
      source: binding?.source,
      exposure: requirement.exposure
    };
  });
  return {
    ok: status.every((item) => item.configured),
    requirements: status,
    missingEnv: status.filter((item) => !item.configured).map((item) => item.envName)
  };
}
