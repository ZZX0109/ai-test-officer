import { Router, type Request } from "express";
import { z } from "zod";
import { commandSpecSchema, projectManifestSchema } from "@ai-test-officer/contracts";
import { getCredential } from "../../credentialStore.js";
import {
  getProject,
  getProjectRuntimeStatus,
  getProjectRuntimeStatusWithRecovery,
  listProjects,
  saveProject,
  stopProject,
  testProjectConnection,
  toTargetProjectConfig
} from "../../projectAdapter.js";
import { detectProject, detectProjectManifest, diagnoseProject } from "../../projectDetection.js";
import { chooseNativeProjectFolder, listProjectDirectory } from "../../projectFolderBrowser.js";
import { saveProjectLoginSecret } from "../../projectLoginStore.js";
import { loadProjectManifest, manifestToProjectConfig } from "../../projectManifest.js";
import { authContext, requireRole } from "../../security.js";
import { createProjectGrant, listAccessibleProjectIds, projectScopeForOperation } from "../../projectAccess.js";
import { createRuntimeRecoveryAdvice } from "../../runtimeStartupAdvisor.js";
import type { ProjectConfig } from "../../types.js";
import { closeBrowserSessionsForProject } from "../../browser-agent/sessionManager.js";
import { projectMemberRouter } from "./projectMember.routes.js";
import type { ProjectScope } from "../services/runAccess.service.js";
import type { ProjectRuntimeService } from "../services/projectRuntime.service.js";

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  projectPath: z.string().min(1),
  demoProfile: z.object({
    enabled: z.boolean(),
    description: z.string().min(1).max(500),
    defaultGoal: z.string().min(1).max(2_000),
    scenarioId: z.string().min(1)
  }).optional(),
  allowExternalProjectPath: z.boolean().optional(),
  installCommand: z.string().optional(),
  installCommandSpec: commandSpecSchema.optional(),
  startCommand: z.string().optional(),
  startCommandSpec: commandSpecSchema.optional(),
  processes: z.array(z.object({
    name: z.string().min(1),
    command: z.string().min(1),
    commandSpec: commandSpecSchema.optional(),
    healthCheckUrl: z.string().url().optional(),
    required: z.boolean().optional()
  })).optional(),
  healthCheckUrl: z.string().url().optional(),
  frontendUrl: z.string().url(),
  backendUrl: z.string().url().optional(),
  testCommand: z.string().optional(),
  testCommandSpec: commandSpecSchema.optional(),
  allowedOrigins: z.array(z.string().url()).optional(),
  login: z
    .object({
      method: z.enum(["none", "form", "storage_state", "env"]),
      usernameEnv: z.string().optional(),
      passwordEnv: z.string().optional(),
      credentialId: z.string().optional(),
      loginUrl: z.string().url().optional()
    })
    .optional(),
  apiCredentialRequirements: z.array(z.object({
    envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    providerHint: z.string().max(80).optional(),
    baseUrlEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    modelEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    exposure: z.enum(["server", "browser"]),
    signals: z.array(z.string().max(500)).max(20)
  })).max(20).optional(),
  apiCredentialBindings: z.array(z.object({
    envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    credentialId: z.string().min(1),
    source: z.enum(["test-system", "dedicated"]),
    baseUrlEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    modelEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    configuredAt: z.string().datetime()
  })).max(20).optional(),
  env: z.record(z.string()).optional(),
  cleanupCommand: z.string().optional(),
  cleanupCommandSpec: commandSpecSchema.optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  externalSmokeProfile: z.object({
    login: z.object({
      usernameEnv: z.string().optional(),
      passwordEnv: z.string().optional(),
      expectedText: z.string().optional()
    }).optional(),
    keyPages: z.array(z.object({
      id: z.string(),
      path: z.string(),
      expectedHeading: z.string().optional()
    })).optional(),
    form: z.object({
      path: z.string().optional(),
      inputLabel: z.string(),
      inputValue: z.string(),
      submitButton: z.string(),
      expectedText: z.string()
    }).optional(),
    table: z.object({
      path: z.string().optional(),
      sortButton: z.string().optional(),
      filterLabel: z.string().optional(),
      filterValue: z.string().optional(),
      nextButton: z.string().optional(),
      expectedText: z.string()
    }).optional(),
    permission: z.object({
      roleControlLabel: z.string().optional(),
      roleValue: z.string().optional(),
      expectedText: z.string()
    }).optional(),
    apiSteps: z.array(z.object({
      id: z.string(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string(),
      expectedStatus: z.number().int().optional(),
      requiresAuth: z.boolean().optional()
    })).optional(),
    browserSteps: z.array(z.object({
      id: z.string(),
      action: z.enum(["click", "fill", "upload", "assert_text"]),
      label: z.string().optional(),
      value: z.string().optional(),
      expectedText: z.string().optional()
    })).optional()
  }).optional(),
  manifest: projectManifestSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});

export function projectRouter(input: {
  rootDir: string;
  assertProjectAccess: (req: Request, projectId: unknown, scope: ProjectScope) => Promise<void>;
  runtime: ProjectRuntimeService;
}) {
  const router = Router();

  router.get("/api/projects", async (req, res, next) => {
    try {
      const context = authContext(req);
      const projects = await listProjects();
      if (!context || context.subject === "local-dev" || context.roles.includes("admin")) {
        res.json({ projects });
        return;
      }
      const allowed = new Set(await listAccessibleProjectIds(context.subject));
      res.json({ projects: projects.filter((project) => allowed.has(project.id)) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/v1/projects/manifest", async (req, res, next) => {
    try {
      const repositoryRoot = typeof req.query.repositoryRoot === "string" ? req.query.repositoryRoot : input.rootDir;
      const manifestPath = typeof req.query.manifestPath === "string" ? req.query.manifestPath : undefined;
      const manifest = await loadProjectManifest({ repositoryRoot, manifestPath });
      res.json({ manifest, project: manifestToProjectConfig(manifest, repositoryRoot) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/detect", async (req, res, next) => {
    try {
      const body = z.object({ projectPath: z.string().min(1) }).parse(req.body);
      res.json({ detection: await detectProject(body.projectPath) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/choose-folder", async (_req, res, next) => {
    try {
      res.json({ selection: await chooseNativeProjectFolder() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/list-directory", async (req, res, next) => {
    try {
      const body = z.object({
        projectPath: z.string().min(1).max(4096),
        relativePath: z.string().max(4096).optional()
      }).parse(req.body);
      res.json({ entries: await listProjectDirectory(body) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/detect-manifest", async (req, res, next) => {
    try {
      const body = z.object({
        rootName: z.string().min(1).max(255),
        files: z.array(z.object({
          relativePath: z.string().min(1).max(1024),
          content: z.string().max(300_000).optional()
        })).max(250)
      }).parse(req.body);
      res.json({ detection: await detectProjectManifest(body) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects", requireRole(["admin", "runner"]), async (req, res, next) => {
    try {
      const project = await saveProject(projectSchema.parse(req.body) as ProjectConfig);
      const context = authContext(req);
      if (context && context.subject !== "local-dev" && !context.roles.includes("admin")) {
        await createProjectGrant({ projectId: project.id, subject: context.subject, role: "owner" });
      }
      res.status(201).json({ project });
    } catch (error) {
      next(error);
    }
  });

  router.use("/api/projects/:id", async (req, _res, next) => {
    try {
      if (!await getProject(req.params.id)) throw new Error("project_not_found_or_forbidden");
      await input.assertProjectAccess(req, req.params.id, projectScopeForOperation(req));
      next();
    } catch (error) {
      next(error);
    }
  });
  router.use("/api/projects/:id/grants", projectMemberRouter());

  router.post("/api/projects/:id/login-credential", requireRole(["admin", "runner"]), async (req, res, next) => {
    try {
      const body = z.object({
        username: z.string().min(1).max(320),
        password: z.string().min(1).max(4096),
        usernameEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("E2E_USERNAME"),
        passwordEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("E2E_PASSWORD")
      }).parse(req.body);
      const current = await getProject(req.params.id);
      if (!current) return void res.status(404).json({ error: "Project not found" });
      const credential = await saveProjectLoginSecret({
        projectId: current.id,
        username: body.username,
        password: body.password
      });
      const environmentAllowlist = Array.from(new Set([
        ...(current.manifest?.environmentAllowlist ?? []),
        body.usernameEnv,
        body.passwordEnv
      ]));
      const project = await saveProject({
        ...current,
        login: {
          method: "env",
          usernameEnv: body.usernameEnv,
          passwordEnv: body.passwordEnv,
          credentialId: credential.id
        },
        manifest: current.manifest ? { ...current.manifest, environmentAllowlist } : undefined
      });
      res.status(201).json({ project, credential });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/:id/api-credential-binding", requireRole(["admin", "runner"]), async (req, res, next) => {
    try {
      const body = z.object({
        envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
        credentialId: z.string().min(1),
        source: z.enum(["test-system", "dedicated"]),
        baseUrlEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
        modelEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional()
      }).parse(req.body);
      const current = await getProject(req.params.id);
      if (!current) return void res.status(404).json({ error: "Project not found" });
      const requirement = current.apiCredentialRequirements?.find((item) => item.envName === body.envName);
      if (!requirement) return void res.status(400).json({ error: `Project does not declare API credential requirement ${body.envName}.` });
      const credential = await getCredential(body.credentialId);
      if (!credential) return void res.status(404).json({ error: "Credential not found" });
      const binding = {
        envName: body.envName,
        credentialId: body.credentialId,
        source: body.source,
        baseUrlEnv: body.baseUrlEnv ?? requirement.baseUrlEnv,
        modelEnv: body.modelEnv ?? requirement.modelEnv,
        configuredAt: new Date().toISOString()
      };
      const apiCredentialBindings = [
        ...(current.apiCredentialBindings ?? []).filter((item) => item.envName !== body.envName),
        binding
      ];
      const environmentAllowlist = Array.from(new Set([
        ...(current.manifest?.environmentAllowlist ?? []),
        binding.envName,
        binding.baseUrlEnv,
        binding.modelEnv
      ].filter((value): value is string => Boolean(value))));
      const project = await saveProject({
        ...current,
        apiCredentialBindings,
        manifest: current.manifest ? { ...current.manifest, environmentAllowlist } : undefined
      });
      res.status(201).json({
        project,
        binding,
        credential: {
          id: credential.id,
          name: credential.name,
          provider: credential.provider,
          model: credential.model,
          apiKeyMasked: credential.apiKeyMasked
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/projects/:id", async (req, res, next) => {
    try {
      const current = await getProject(req.params.id);
      if (!current) return void res.status(404).json({ error: "Project not found" });
      const project = await saveProject(projectSchema.parse({ ...current, ...req.body, id: req.params.id }) as ProjectConfig);
      res.json({ project });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/projects/:id/runtime", async (req, res, next) => {
    try {
      res.json({ runtime: await getProjectRuntimeStatusWithRecovery(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/projects/:id/recovery", async (req, res, next) => {
    try {
      res.json({ recovery: await input.runtime.recoveryPreview(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/:id/recover-and-retry", async (req, res, next) => {
    try {
      const body = z.object({
        mode: z.enum(["auto", "runtime", "discovery"]).default("auto"),
        credentialId: z.string().min(1).max(200).optional()
      }).strict().parse(req.body ?? {});
      const project = await getProject(req.params.id);
      if (!project) return void res.status(404).json({ error: "project_not_found" });
      const existing = input.runtime.getRecoverySnapshot(req.params.id);
      const preview = await input.runtime.recoveryPreview(req.params.id);
      const task = input.runtime.recoverAndRetryProject(req.params.id, body.mode, body.credentialId);
      // Deliberately return immediately: Docker startup and dependency recovery
      // may take minutes. The Workbench polls this same recovery record and
      // updates one conversation message instead of leaving a dead button.
      task.catch(() => undefined);
      res.status(202).json({
        accepted: true,
        recovery: existing ?? input.runtime.getRecoverySnapshot(req.params.id) ?? {
          ...preview,
          action: body.mode === "discovery" ? "retry-discovery" : preview.action,
          userAction: "系统已接收恢复请求，正在同步安全沙盒状态。"
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/projects/:id/target-contract", async (req, res, next) => {
    try {
      const project = await getProject(req.params.id);
      if (!project) return void res.status(404).json({ error: "Project not found" });
      res.json({ contract: toTargetProjectConfig(project) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/:id/test-connection", async (req, res, next) => {
    try {
      const project = await input.runtime.refreshExternalProjectLaunchContract(req.params.id);
      if (!project) return void res.status(404).json({ error: "Project not found" });
      res.json({ result: await testProjectConnection(project) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/:id/diagnose", async (req, res, next) => {
    try {
      await input.runtime.refreshExternalProjectLaunchContract(req.params.id);
      res.json({ diagnosis: await diagnoseProject(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/:id/start", async (req, res, next) => {
    try {
      res.json({ runtime: await input.runtime.startProjectWithFreshConfig(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  // The interactive Workbench must not hold the browser request open while an
  // install or health check runs. The task is still owned by the Agent; clients
  // observe it through the runtime endpoint until a terminal status is reached.
  router.post("/api/projects/:id/start-async", async (req, res, next) => {
    try {
      const result = await input.runtime.startProjectAsync(req.params.id);
      res.status(result.runtime.status === "running" ? 200 : 202).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/:id/ai-start-recovery", async (req, res, next) => {
    try {
      const body = z.object({ credentialId: z.string().optional() }).parse(req.body ?? {});
      const project = await getProject(req.params.id);
      if (!project) return void res.status(404).json({ error: "project_not_found" });
      const runtime = getProjectRuntimeStatus(req.params.id);
      if (runtime.status !== "failed") return void res.status(409).json({ error: "runtime_not_failed" });
      const advice = await createRuntimeRecoveryAdvice({ project, runtime, credentialId: body.credentialId });
      res.json({ advice });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/projects/:id/stop", async (req, res, next) => {
    try {
      // Stopping the project runtime must also tear down any live browser
      // contexts bound to it; otherwise Playwright sessions linger against a dead
      // origin until their lease expires.
      await closeBrowserSessionsForProject(req.params.id).catch(() => undefined);
      res.json({ runtime: await stopProject(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
