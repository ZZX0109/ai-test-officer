import { z } from "zod";

export const commandSpecSchema = z.object({
  executable: z.string().regex(/^[a-zA-Z0-9._/+:-]+$/),
  args: z.array(z.string().max(4096)).max(128).default([]),
  timeoutMs: z.number().int().positive().max(1_200_000).optional()
});
export type CommandSpec = z.infer<typeof commandSpecSchema>;

export const resourceBudgetSchema = z.object({
  runTimeoutMs: z.number().int().positive().default(1_200_000),
  prepareTimeoutMs: z.number().int().positive().default(300_000),
  scenarioTimeoutMs: z.number().int().positive().default(300_000),
  stepTimeoutMs: z.number().int().positive().default(45_000),
  maxSteps: z.number().int().positive().default(50),
  maxAttempts: z.number().int().min(1).max(2).default(2),
  maxScreenshots: z.number().int().nonnegative().default(100),
  maxVideoBytes: z.number().int().nonnegative().default(500 * 1024 * 1024),
  maxLogBytes: z.number().int().nonnegative().default(50 * 1024 * 1024),
  maxArtifactBytes: z.number().int().nonnegative().default(1024 * 1024 * 1024),
  maxConcurrency: z.number().int().positive().default(2)
});
export type ResourceBudget = z.infer<typeof resourceBudgetSchema>;
export const defaultResourceBudget: ResourceBudget = resourceBudgetSchema.parse({});

export const projectManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  projectId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  workspaceRoot: z.string().min(1),
  commands: z.object({
    install: commandSpecSchema.optional(),
    migrate: commandSpecSchema.optional(),
    seed: commandSpecSchema.optional(),
    start: commandSpecSchema.optional(),
    targetedTest: commandSpecSchema.optional(),
    relatedTest: commandSpecSchema.optional(),
    test: commandSpecSchema.optional(),
    cleanup: commandSpecSchema.optional()
  }),
  commandAllowlist: z.array(z.string().regex(/^[a-zA-Z0-9._/+:-]+$/)).min(1),
  ports: z.array(z.object({ name: z.string().min(1), env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), purpose: z.enum(["frontend", "backend", "health", "auxiliary"]) })).default([]),
  healthCheck: z.object({ path: z.string().startsWith("/"), timeoutMs: z.number().int().positive().default(20_000) }).optional(),
  environmentAllowlist: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  network: z.object({
    mode: z.enum(["deny", "allow-target", "allowlist"]).default("allow-target"),
    allowedHosts: z.array(z.string().min(1)).max(128).default([]),
    /** Non-deny execution must name an externally enforced egress-only network. */
    enforcement: z.enum(["none", "external-egress-proxy"]).default("none")
  }).default({}),
  fixtures: z.array(z.object({ id: z.string().min(1), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), destructive: z.boolean().default(false) })).default([]),
  /** Optional human-owned mapping for API-only products. An endpoint is not a
   * business function unless it is explicitly attached to one of these names. */
  businessCapabilities: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    name: z.string().min(1).max(160),
    purpose: z.string().max(500).optional(),
    pathIds: z.array(z.string()).default([]),
    routePrefixes: z.array(z.string().startsWith("/")).default([]),
    risk: z.enum(["low", "medium", "high"]).default("medium")
  })).default([]),
  apiOperations: z.array(z.object({
    operationId: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    pathTemplate: z.string().startsWith("/"),
    baseUrlRef: z.enum(["frontend", "backend"]).default("backend"),
    allowedStatusCodes: z.array(z.number().int().min(100).max(599)).min(1).default([200]),
    fixtureRef: z.string().min(1).optional(),
    destructive: z.boolean().default(false),
    // Mutable operations are executable only when the target explicitly
    // participates in the stable action-key protocol.  Requiring an echoed
    // response key lets the executor fail closed instead of assuming that an
    // arbitrary POST endpoint implemented idempotency.
    idempotency: z.object({
      requestHeader: z.string().regex(/^[A-Za-z0-9-]+$/),
      responseHeader: z.string().regex(/^[A-Za-z0-9-]+$/)
    }).optional()
  })).default([]),
  dataSources: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    kind: z.enum(["postgres", "sqlite", "http-snapshot"]),
    connectionEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    readOnly: z.boolean().default(true),
    queryTemplates: z.array(z.object({
      id: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
      statement: z.string().min(1),
      parameterNames: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)).default([]),
      expectation: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("non-empty") }),
        z.object({ kind: z.literal("empty") }),
        z.object({ kind: z.literal("row-count"), value: z.number().int().nonnegative() }),
        z.object({ kind: z.literal("scalar-equals"), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) })
      ])
    })).default([])
  })).default([]),
  backgroundTasks: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    statusOperationId: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    statusField: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.]*$/).default("status"),
    terminalStates: z.array(z.string().min(1)).min(1),
    successStates: z.array(z.string().min(1)).min(1),
    pollIntervalMs: z.number().int().min(100).max(30_000).default(1_000),
    timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000)
  })).default([]),
  capabilities: z.object({ browser: z.boolean().default(true), desktop: z.boolean().default(false), allowedBundleIds: z.array(z.string()).default([]) }).default({}),
  execution: z.object({
    mode: z.enum(["oci", "trusted-local"]).default("oci"),
    image: z.string().min(1).optional(),
    engine: z.literal("docker").default("docker"),
    /**
     * The source project already carries installed dependencies (e.g. host
     * `node_modules` / `.venv` pre-populated to avoid a sandbox cold install
    * that would need registry egress the deny/isolated network policy blocks).
    * When true the execution worker copies dependency directories into the
    * writable workspace (instead of excluding them) and skips the prepare
    * (install) command, so the project starts without any network access.
    */
    preinstalledDependencies: z.boolean().optional(),
    /**
     * Optional path inside the OCI image that contains a Linux-native project
     * dependency tree. This is used for external projects whose host
     * node_modules were installed on another operating system or architecture.
     */
    preinstalledDependencyImageRoot: z.string().min(1).optional()
  }).default({}),
  budget: resourceBudgetSchema.default({})
}).superRefine((manifest, context) => {
  if (manifest.execution.mode === "oci" && !manifest.execution.image) context.addIssue({ code: z.ZodIssueCode.custom, path: ["execution", "image"], message: "OCI execution requires an immutable image." });
});
export type ProjectManifest = z.infer<typeof projectManifestSchema>;
