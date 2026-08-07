/**
 * Schema 版本管理合约
 *
 * API Contract version、Tool version、Database migration version
 */

import { z } from "zod";

// ─── 版本号格式 ──────────────────────────────────────────────────

export const semanticVersionSchema = z.string().regex(
  /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/
);
export type SemanticVersion = z.infer<typeof semanticVersionSchema>;

// ─── API Contract ────────────────────────────────────────────────

export const apiContractVersionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  contractId: z.string().min(1),
  routePath: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  version: semanticVersionSchema,
  changelog: z.array(z.object({
    changeId: z.string().min(1),
    changeType: z.enum(["added", "modified", "deprecated", "removed", "fixed"]),
    description: z.string().max(500),
    breakingChange: z.boolean().default(false),
    migrationNotes: z.string().max(2_000).optional(),
    authorId: z.string(),
    committedAt: z.string().datetime()
  })).default([]),
  requestSchema: z.record(z.unknown()).optional(),
  responseSchema: z.record(z.unknown()).optional(),
  isDeprecated: z.boolean().default(false),
  deprecatedAt: z.string().datetime().optional(),
  sunsetAt: z.string().datetime().optional(),
  successorContractId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ApiContractVersion = z.infer<typeof apiContractVersionSchema>;

// ─── Tool Version ────────────────────────────────────────────────

export const toolVersionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  toolId: z.string().min(1),
  toolName: z.string().min(1),
  version: semanticVersionSchema,
  capability: z.string().min(1),
  isReadOnly: z.boolean(),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()),
  changelog: z.array(z.object({
    changeId: z.string().min(1),
    changeType: z.enum(["added", "modified", "deprecated", "removed", "fixed"]),
    description: z.string().max(500),
    breakingChange: z.boolean().default(false),
    authorId: z.string(),
    committedAt: z.string().datetime()
  })).default([]),
  compatibleApiContractVersions: z.array(z.string()).default([]),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).default("low"),
  approvalRequired: z.boolean().default(false),
  isDeprecated: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ToolVersion = z.infer<typeof toolVersionSchema>;

// ─── Database Migration ──────────────────────────────────────────

export const dbMigrationVersionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  migrationId: z.string().min(1),
  version: semanticVersionSchema,
  sequence: z.number().int().nonnegative(),
  description: z.string().max(500),
  upSql: z.string().min(1),
  downSql: z.string().min(1),
  isDestructive: z.boolean().default(false),
  affectedTables: z.array(z.string()).default([]),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  appliedAt: z.string().datetime().optional(),
  appliedBy: z.string().optional(),
  status: z.enum(["pending", "applied", "failed", "rolled_back"]).default("pending"),
  rollbackChecksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.string().datetime()
});
export type DbMigrationVersion = z.infer<typeof dbMigrationVersionSchema>;

// ─── 版本兼容性矩阵 ──────────────────────────────────────────────

export const versionCompatibilitySchema = z.object({
  schemaVersion: z.literal("1.0"),
  systemVersion: semanticVersionSchema,
  contracts: z.object({
    apiContracts: z.array(z.object({
      contractId: z.string(),
      version: semanticVersionSchema,
      deprecated: z.boolean()
    })),
    tools: z.array(z.object({
      toolId: z.string(),
      version: semanticVersionSchema,
      deprecated: z.boolean()
    }))
  }),
  database: z.object({
    currentVersion: semanticVersionSchema,
    appliedMigrations: z.number().int().nonnegative(),
    pendingMigrations: z.number().int().nonnegative()
  }),
  compatibilityChecks: z.array(z.object({
    checkId: z.string(),
    description: z.string(),
    passed: z.boolean(),
    details: z.string().optional()
  })),
  generatedAt: z.string().datetime()
});
export type VersionCompatibility = z.infer<typeof versionCompatibilitySchema>;
