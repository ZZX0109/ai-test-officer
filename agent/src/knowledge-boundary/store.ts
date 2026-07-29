import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import {
  agentMessageSchema,
  knowledgeConflictSchema,
  knowledgeDecisionSchema,
  knowledgeToolExecutionSchema,
  llmKnowledgeContextSchema,
  type AgentMessage,
  type KnowledgeConflict,
  type KnowledgeDecision,
  type KnowledgeToolExecution,
  type LlmKnowledgeContext
} from "@ai-test-officer/contracts";
import { publishKnowledgeLifecycle } from "./lifecycle.js";
import { redactForModel } from "./redaction.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const knowledgeRoot = path.join(rootDir, "reports", "knowledge");
let postgresPool: Pool | undefined;

function pool() {
  if (!process.env.DATABASE_URL) return undefined;
  postgresPool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return postgresPool;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function runDirectory(runId?: string) {
  return path.join(knowledgeRoot, runId ?? "unassigned");
}

async function writeAppendOnly(kind: string, id: string, value: unknown, runId?: string) {
  const directory = path.join(runDirectory(runId), kind);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.json`);
  try {
    await readFile(file);
    return;
  } catch {
    await writeFile(file, JSON.stringify(value, null, 2), { flag: "wx" });
  }
}

async function readJsonFiles<T>(directory: string, parse: (value: unknown) => T | undefined) {
  const result: T[] = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parse(JSON.parse(await readFile(path.join(directory, name), "utf8")));
      if (parsed) result.push(parsed);
    } catch {
      // A corrupt local audit record is excluded and reported by integrity checks.
    }
  }
  return result;
}

export async function persistKnowledgeContext(contextInput: LlmKnowledgeContext) {
  const context = llmKnowledgeContextSchema.parse({
    ...contextInput,
    id: contextInput.id ?? `knowledge_context_${randomUUID()}`
  });
  const contextId = context.id!;
  const digest = canonicalSha256(context);
  await writeAppendOnly("contexts", contextId, { ...context, canonicalSha256: digest }, context.runId);
  const database = pool();
  if (database) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO llm_knowledge_contexts_v1
         (id,run_id,invocation_id,purpose,project_id,project_digest,canonical_sha256,payload,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [
          contextId,
          context.runId ?? null,
          context.invocationId ?? null,
          context.purpose,
          context.projectSnapshot?.projectId ?? null,
          context.projectSnapshot?.projectDigest ?? null,
          digest,
          context,
          context.generatedAt
        ]
      );
      for (const claim of context.claims) {
        await client.query(
          `INSERT INTO knowledge_claims_v1
           (row_id,claim_id,context_id,run_id,status,domain,canonical_sha256,payload,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (context_id,claim_id) DO NOTHING`,
          [
            `${contextId}:${claim.id}`,
            claim.id,
            contextId,
            context.runId ?? null,
            claim.status,
            claim.domain,
            canonicalSha256(claim),
            claim,
            context.generatedAt
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  publishKnowledgeLifecycle({
    runId: context.runId,
    type: "knowledge.context.created",
    payload: { contextId, purpose: context.purpose, canonicalSha256: digest }
  });
  return context;
}

export async function persistKnowledgeDecision(
  input: Omit<KnowledgeDecision, "id" | "canonicalSha256" | "createdAt"> & {
    id?: string;
    createdAt?: string;
  }
) {
  const id = input.id ?? `knowledge_decision_${randomUUID()}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const unsigned = { ...input, id, createdAt };
  const decision = knowledgeDecisionSchema.parse({
    ...unsigned,
    canonicalSha256: canonicalSha256(unsigned)
  });
  await writeAppendOnly("decisions", id, decision, decision.runId);
  const database = pool();
  if (database) {
    await database.query(
      `INSERT INTO knowledge_decisions_v1
       (id,context_id,run_id,invocation_id,validation_status,canonical_sha256,payload,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [
        id,
        decision.contextId,
        decision.runId ?? null,
        decision.invocationId ?? null,
        decision.validationStatus,
        decision.canonicalSha256,
        decision,
        createdAt
      ]
    );
    if (decision.invocationId) {
      await database.query(
        `UPDATE llm_invocations_v1
         SET knowledge_context_id=$2, knowledge_decision_id=$3,
             knowledge_tool_execution_ids=$4,
             boundary_policy_version=$5, knowledge_validation_status=$6
         WHERE id=$1`,
        [
          decision.invocationId,
          decision.contextId,
          decision.id,
          JSON.stringify(decision.toolExecutionIds),
          decision.policyVersion,
          decision.validationStatus
        ]
      );
    }
  }
  return decision;
}

export async function persistKnowledgeConflict(
  input: Omit<KnowledgeConflict, "id" | "canonicalSha256" | "createdAt"> & {
    id?: string;
    createdAt?: string;
  }
) {
  const id = input.id ?? `knowledge_conflict_${randomUUID()}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const unsigned = { ...input, id, createdAt };
  const conflict = knowledgeConflictSchema.parse({
    ...unsigned,
    canonicalSha256: canonicalSha256(unsigned)
  });
  await writeAppendOnly("conflicts", id, conflict, conflict.runId);
  const database = pool();
  if (database) {
    await database.query(
      `INSERT INTO knowledge_conflicts_v1
       (id,context_id,run_id,status,canonical_sha256,payload,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [
        id,
        conflict.contextId,
        conflict.runId ?? null,
        conflict.status,
        conflict.canonicalSha256,
        conflict,
        createdAt
      ]
    );
  }
  publishKnowledgeLifecycle({
    runId: conflict.runId,
    type: conflict.status === "resolved" ? "knowledge.conflict.resolved" : "knowledge.conflict.created",
    payload: { conflictId: id, contextId: conflict.contextId, domain: conflict.domain }
  });
  return conflict;
}

export async function persistKnowledgeToolExecution(executionInput: KnowledgeToolExecution) {
  const execution = knowledgeToolExecutionSchema.parse(executionInput);
  const digest = canonicalSha256(execution);
  await writeAppendOnly("tools", execution.id, { ...execution, canonicalSha256: digest }, execution.runId);
  const database = pool();
  if (database) {
    await database.query(
      `INSERT INTO knowledge_tool_executions_v1
       (id,context_id,run_id,tool_name,input_sha256,status,canonical_sha256,payload,started_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (context_id,tool_name,input_sha256) DO NOTHING`,
      [
        execution.id,
        execution.contextId,
        execution.runId ?? null,
        execution.request.tool,
        execution.inputSha256,
        execution.status,
        digest,
        execution,
        execution.startedAt,
        execution.completedAt ?? null
      ]
    );
  }
  return execution;
}

export async function readKnowledgeToolExecution(
  id: string,
  runId?: string
): Promise<KnowledgeToolExecution | undefined> {
  const database = pool();
  if (database) {
    const result = await database.query<{ payload: unknown }>(
      "SELECT payload FROM knowledge_tool_executions_v1 WHERE id=$1",
      [id]
    );
    const parsed = knowledgeToolExecutionSchema.safeParse(result.rows[0]?.payload);
    return parsed.success ? parsed.data : undefined;
  }
  try {
    const raw = JSON.parse(
      await readFile(path.join(runDirectory(runId), "tools", `${id}.json`), "utf8")
    );
    const parsed = knowledgeToolExecutionSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function appendAgentMessage(
  input: Omit<AgentMessage, "id" | "createdAt"> & { id?: string; createdAt?: string }
) {
  const message = agentMessageSchema.parse({
    ...input,
    content: redactForModel(input.content),
    id: input.id ?? `agent_message_${randomUUID()}`,
    createdAt: input.createdAt ?? new Date().toISOString()
  });
  const digest = canonicalSha256(message);
  await writeAppendOnly("messages", message.id, { ...message, canonicalSha256: digest }, message.runId);
  const database = pool();
  if (database) {
    await database.query(
      `INSERT INTO agent_messages_v1
       (id,run_id,role,knowledge_context_id,knowledge_decision_id,llm_call_id,canonical_sha256,payload,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [
        message.id,
        message.runId,
        message.role,
        message.knowledgeContextId ?? null,
        message.knowledgeDecisionId ?? null,
        message.llmCallId ?? null,
        digest,
        message,
        message.createdAt
      ]
    );
  }
  return message;
}

export async function readKnowledgeContext(id: string) {
  const database = pool();
  if (database) {
    const result = await database.query<{ payload: unknown }>(
      "SELECT payload FROM llm_knowledge_contexts_v1 WHERE id=$1",
      [id]
    );
    const parsed = llmKnowledgeContextSchema.safeParse(result.rows[0]?.payload);
    return parsed.success ? parsed.data : undefined;
  }
  for (const runId of await readdir(knowledgeRoot).catch(() => [])) {
    try {
      const raw = JSON.parse(await readFile(path.join(runDirectory(runId), "contexts", `${id}.json`), "utf8"));
      const parsed = llmKnowledgeContextSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
    } catch {
      // Continue searching local run directories.
    }
  }
  return undefined;
}

export async function listRunKnowledge(runId: string) {
  const database = pool();
  if (database) {
    const [contexts, decisions] = await Promise.all([
      database.query<{ payload: unknown }>(
        "SELECT payload FROM llm_knowledge_contexts_v1 WHERE run_id=$1 ORDER BY created_at",
        [runId]
      ),
      database.query<{ payload: unknown }>(
        "SELECT payload FROM knowledge_decisions_v1 WHERE run_id=$1 ORDER BY created_at",
        [runId]
      )
    ]);
    return {
      contexts: contexts.rows.flatMap(({ payload }) => {
        const parsed = llmKnowledgeContextSchema.safeParse(payload);
        return parsed.success ? [parsed.data] : [];
      }),
      decisions: decisions.rows.flatMap(({ payload }) => {
        const parsed = knowledgeDecisionSchema.safeParse(payload);
        return parsed.success ? [parsed.data] : [];
      })
    };
  }
  return {
    contexts: await readJsonFiles(path.join(runDirectory(runId), "contexts"), (value) => {
      const parsed = llmKnowledgeContextSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    }),
    decisions: await readJsonFiles(path.join(runDirectory(runId), "decisions"), (value) => {
      const parsed = knowledgeDecisionSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    })
  };
}

export async function listRunKnowledgeConflicts(runId: string) {
  const database = pool();
  if (database) {
    const result = await database.query<{ payload: unknown }>(
      "SELECT payload FROM knowledge_conflicts_v1 WHERE run_id=$1 ORDER BY created_at",
      [runId]
    );
    return result.rows.flatMap(({ payload }) => {
      const parsed = knowledgeConflictSchema.safeParse(payload);
      return parsed.success ? [parsed.data] : [];
    });
  }
  return readJsonFiles(path.join(runDirectory(runId), "conflicts"), (value) => {
    const parsed = knowledgeConflictSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });
}

export async function listRunKnowledgeToolExecutions(runId: string) {
  const database = pool();
  if (database) {
    const result = await database.query<{ payload: unknown }>(
      "SELECT payload FROM knowledge_tool_executions_v1 WHERE run_id=$1 ORDER BY started_at",
      [runId]
    );
    return result.rows.flatMap(({ payload }) => {
      const parsed = knowledgeToolExecutionSchema.safeParse(payload);
      return parsed.success ? [parsed.data] : [];
    });
  }
  return readJsonFiles(path.join(runDirectory(runId), "tools"), (value) => {
    const parsed = knowledgeToolExecutionSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });
}

export async function listAgentMessages(runId: string) {
  const database = pool();
  if (database) {
    const result = await database.query<{ payload: unknown }>(
      "SELECT payload FROM agent_messages_v1 WHERE run_id=$1 ORDER BY created_at",
      [runId]
    );
    return result.rows.flatMap(({ payload }) => {
      const parsed = agentMessageSchema.safeParse(payload);
      return parsed.success ? [parsed.data] : [];
    });
  }
  const messages = await readJsonFiles(path.join(runDirectory(runId), "messages"), (value) => {
    const parsed = agentMessageSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });
  return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function findKnowledgeClaim(claimId: string, contextId?: string) {
  const database = pool();
  if (database) {
    const result = await database.query<{ payload: unknown; context_id: string; run_id: string | null }>(
      `SELECT payload, context_id, run_id
       FROM knowledge_claims_v1
       WHERE claim_id=$1 AND ($2::text IS NULL OR context_id=$2)
       ORDER BY created_at DESC LIMIT 1`,
      [claimId, contextId ?? null]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { claim: row.payload, contextId: row.context_id, runId: row.run_id ?? undefined };
  }
  for (const runId of await readdir(knowledgeRoot).catch(() => [])) {
    const contexts = await listRunKnowledge(runId);
    for (const context of contexts.contexts.slice().reverse()) {
      if (contextId && context.id !== contextId) continue;
      const claim = context.claims.find((item) => item.id === claimId);
      if (claim) return { claim, contextId: context.id!, runId: context.runId };
    }
  }
  return undefined;
}
