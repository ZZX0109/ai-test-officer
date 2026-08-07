/**
 * LLM 输入优化合约
 *
 * 发送 Verified Facts / Observed Evidence / Retrieved Knowledge / Unknown Information
 * 不发送原始数据库 / 全量日志 / 全量 DOM
 */

import { z } from "zod";

// ─── 信息分类 ────────────────────────────────────────────────────

export const informationCategorySchema = z.enum([
  "verified_fact",
  "observed_evidence",
  "retrieved_knowledge",
  "unknown_information"
]);
export type InformationCategory = z.infer<typeof informationCategorySchema>;

// ─── Verified Fact ───────────────────────────────────────────────

export const verifiedFactSchema = z.object({
  factId: z.string().min(1),
  source: z.enum([
    "test_execution",
    "api_response",
    "database_query",
    "user_input",
    "static_analysis",
    "previous_run"
  ]),
  statement: z.string().max(500),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string()).max(10),
  verifiedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  scope: z.enum(["run", "project", "global"]).default("run")
});
export type VerifiedFact = z.infer<typeof verifiedFactSchema>;

// ─── Observed Evidence ───────────────────────────────────────────

export const observedEvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  type: z.enum([
    "screenshot",
    "dom_snapshot",
    "console_log",
    "network_request",
    "network_response",
    "console_error",
    "action_result",
    "assertion_result",
    "page_state",
    "element_state"
  ]),
  summary: z.string().max(300),
  detail: z.string().max(2_000),
  timestamp: z.string().datetime(),
  artifactRefs: z.array(z.string()).max(5),
  locator: z.object({
    url: z.string().optional(),
    selector: z.string().optional(),
    testId: z.string().optional()
  }).optional(),
  relevance: z.number().min(0).max(1).default(1)
});
export type ObservedEvidence = z.infer<typeof observedEvidenceSchema>;

// ─── Retrieved Knowledge ─────────────────────────────────────────

export const retrievedKnowledgeSchema = z.object({
  knowledgeId: z.string().min(1),
  source: z.enum([
    "project_memory",
    "experience_memory",
    "documentation",
    "code_base",
    "external_knowledge"
  ]),
  title: z.string().max(200),
  content: z.string().max(3_000),
  relevanceScore: z.number().min(0).max(1),
  retrievedAt: z.string().datetime(),
  sourceRefs: z.array(z.string()).max(5),
  confidence: z.number().min(0).max(1).default(0.7)
});
export type RetrievedKnowledge = z.infer<typeof retrievedKnowledgeSchema>;

// ─── Unknown Information ─────────────────────────────────────────

export const unknownInformationSchema = z.object({
  unknownId: z.string().min(1),
  category: z.enum([
    "missing_credential",
    "ambiguous_requirement",
    "unreachable_endpoint",
    "undocumented_behavior",
    "incomplete_diff",
    "unknown_error",
    "other"
  ]),
  question: z.string().max(500),
  context: z.string().max(1_000),
  blocking: z.boolean().default(false),
  suggestedResolution: z.string().max(1_000).optional(),
  reportedAt: z.string().datetime()
});
export type UnknownInformation = z.infer<typeof unknownInformationSchema>;

// ─── Optimized LLM Input ─────────────────────────────────────────

export const optimizedLlmInputSchema = z.object({
  schemaVersion: z.literal("1.0"),
  inputId: z.string().min(1),
  runId: z.string().min(1),
  purpose: z.enum(["planning", "execution", "judging", "repair", "assistant"]),

  // 核心分类信息
  verifiedFacts: z.array(verifiedFactSchema).max(20),
  observedEvidence: z.array(observedEvidenceSchema).max(15),
  retrievedKnowledge: z.array(retrievedKnowledgeSchema).max(10),
  unknownInformation: z.array(unknownInformationSchema).max(10),

  // 上下文摘要
  contextSummary: z.string().max(1_000),

  // 明确的禁止项声明
  exclusions: z.object({
    noRawDatabase: z.boolean().default(true),
    noFullLogs: z.boolean().default(true),
    noFullDom: z.boolean().default(true),
    noSourceCodeDump: z.boolean().default(true),
    noCredentials: z.boolean().default(true),
    noInternalState: z.boolean().default(true)
  }),

  // Token 预算
  tokenBudget: z.object({
    total: z.number().int().positive(),
    used: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative()
  }),

  // 编译策略信息
  compilation: z.object({
    strategy: z.enum(["priority", "recent_first", "relevance_sort"]),
    maxFacts: z.number().int(),
    maxEvidence: z.number().int(),
    maxKnowledge: z.number().int(),
    factsSelected: z.number().int(),
    evidenceSelected: z.number().int(),
    knowledgeSelected: z.number().int()
  }),

  generatedAt: z.string().datetime()
});
export type OptimizedLlmInput = z.infer<typeof optimizedLlmInputSchema>;
