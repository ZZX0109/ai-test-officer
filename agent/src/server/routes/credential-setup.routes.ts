import { Router, type Request } from "express";
import { z } from "zod";
import { getCredential, listCredentials } from "../../credentialStore.js";
import { getProject } from "../../projectAdapter.js";
import { getProjectLoginSummary } from "../../projectLoginStore.js";
import { testCredentialConnection } from "../../testConnection.js";
import { requireRole } from "../../security.js";

function selectCredentialId(requested: string | undefined, credentials: Array<{ id: string; isDefault: boolean }>) {
  if (requested) return requested;
  const preferred = credentials.find((item) => item.isDefault);
  if (preferred) return preferred.id;
  return credentials[0]?.id;
}

function loginIsRequired(project: Awaited<ReturnType<typeof getProject>>) {
  return Boolean(project?.login?.method) && project?.login?.method !== "none";
}

function loginMessage(required: boolean, login: { usernameMasked: string } | undefined) {
  if (!required) return "项目不要求登录。";
  return login ? `项目登录凭据已配置（${login.usernameMasked}）。` : "项目要求登录，但测试账号尚未配置。";
}

async function modelCheck(modelCredentialId?: string) {
  const credentials = await listCredentials();
  const id = selectCredentialId(modelCredentialId, credentials);
  const model = id ? await getCredential(id) : undefined;
  const connection = model ? await testCredentialConnection(model) : { ok: false, message: "未配置模型凭据" };
  return {
    id: "model",
    status: connection.ok ? "ready" as const : "blocked" as const,
    message: connection.ok ? `模型 ${model?.model ?? "unknown"} 连接测试通过。` : `模型凭据不可用：${connection.message ?? "未配置"}`,
    remediation: connection.ok ? undefined : "选择或新增一个有效的模型凭据。"
  };
}

async function loginCheck(project: Awaited<ReturnType<typeof getProject>>) {
  const required = loginIsRequired(project);
  const login = required && project?.login?.credentialId ? await getProjectLoginSummary(project.login.credentialId) : undefined;
  return {
    id: "project-login",
    status: !required || login ? "ready" as const : "blocked" as const,
    message: loginMessage(required, login),
    remediation: !required || login ? undefined : "保存项目测试账号后重新检查。"
  };
}

function apiBindingCheck(project: NonNullable<Awaited<ReturnType<typeof getProject>>>) {
  const configured = new Set((project.apiCredentialBindings ?? []).map((item) => item.envName));
  const missing = (project.apiCredentialRequirements ?? []).filter((item) => !configured.has(item.envName));
  return {
    id: "project-api-bindings",
    status: missing.length ? "blocked" as const : "ready" as const,
    message: missing.length ? `缺少项目 API 凭据绑定：${missing.map((item) => item.envName).join(", ")}` : "项目 API 凭据绑定完整。",
    remediation: missing.length ? "为每个 API credential requirement 绑定已加密凭据。" : undefined
  };
}

export function credentialSetupRouter(input: {
  assertProjectAccess: (req: Request, projectId: unknown, scope: "run_tests") => Promise<void>;
}) {
  const router = Router();
  router.post("/v1/projects/:id/credential-setup/check", requireRole(["admin", "runner"]), async (req, res, next) => {
    try {
      const body = z.object({ modelCredentialId: z.string().min(1).optional() }).strict().parse(req.body ?? {});
      const project = await getProject(req.params.id);
      if (!project) return void res.status(404).json({ error: "project_not_found" });
      await input.assertProjectAccess(req, project.id, "run_tests");
      const checks = [await modelCheck(body.modelCredentialId), await loginCheck(project), apiBindingCheck(project)];
      res.json({ projectId: project.id, status: checks.some((item) => item.status === "blocked") ? "blocked" : "ready", checks });
    } catch (error) { next(error); }
  });
  return router;
}
