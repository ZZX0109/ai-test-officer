exports.up = (pgm) => {
  pgm.createTable("llm_knowledge_contexts_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", references: "runs_v1", onDelete: "CASCADE" },
    invocation_id: { type: "text" },
    purpose: { type: "text", notNull: true },
    project_id: { type: "text" },
    project_digest: { type: "text" },
    canonical_sha256: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("llm_knowledge_contexts_v1", ["run_id", "created_at"], { ifNotExists: true });

  pgm.createTable("knowledge_claims_v1", {
    row_id: { type: "text", primaryKey: true },
    claim_id: { type: "text", notNull: true },
    context_id: { type: "text", notNull: true, references: "llm_knowledge_contexts_v1", onDelete: "CASCADE" },
    run_id: { type: "text", references: "runs_v1", onDelete: "CASCADE" },
    status: { type: "text", notNull: true },
    domain: { type: "text", notNull: true },
    canonical_sha256: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.addConstraint("knowledge_claims_v1", "knowledge_claim_context_unique", {
    unique: ["context_id", "claim_id"]
  });
  pgm.createIndex("knowledge_claims_v1", ["run_id", "status"], { ifNotExists: true });

  pgm.createTable("knowledge_decisions_v1", {
    id: { type: "text", primaryKey: true },
    context_id: { type: "text", notNull: true, references: "llm_knowledge_contexts_v1", onDelete: "CASCADE" },
    run_id: { type: "text", references: "runs_v1", onDelete: "CASCADE" },
    invocation_id: { type: "text" },
    validation_status: { type: "text", notNull: true },
    canonical_sha256: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("knowledge_decisions_v1", ["run_id", "created_at"], { ifNotExists: true });

  pgm.createTable("knowledge_conflicts_v1", {
    id: { type: "text", primaryKey: true },
    context_id: { type: "text", notNull: true, references: "llm_knowledge_contexts_v1", onDelete: "CASCADE" },
    run_id: { type: "text", references: "runs_v1", onDelete: "CASCADE" },
    status: { type: "text", notNull: true },
    canonical_sha256: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("knowledge_conflicts_v1", ["run_id", "status"], { ifNotExists: true });

  pgm.createTable("knowledge_tool_executions_v1", {
    id: { type: "text", primaryKey: true },
    context_id: { type: "text", notNull: true, references: "llm_knowledge_contexts_v1", onDelete: "CASCADE" },
    run_id: { type: "text", references: "runs_v1", onDelete: "CASCADE" },
    tool_name: { type: "text", notNull: true },
    input_sha256: { type: "text", notNull: true },
    status: { type: "text", notNull: true },
    canonical_sha256: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    started_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz" }
  }, { ifNotExists: true });
  pgm.addConstraint("knowledge_tool_executions_v1", "knowledge_tool_idempotency", {
    unique: ["context_id", "tool_name", "input_sha256"]
  });
  pgm.createIndex("knowledge_tool_executions_v1", ["run_id", "started_at"], { ifNotExists: true });

  pgm.createTable("agent_messages_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true, references: "runs_v1", onDelete: "CASCADE" },
    role: { type: "text", notNull: true },
    knowledge_context_id: { type: "text", references: "llm_knowledge_contexts_v1", onDelete: "SET NULL" },
    knowledge_decision_id: { type: "text", references: "knowledge_decisions_v1", onDelete: "SET NULL" },
    llm_call_id: { type: "text" },
    canonical_sha256: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("agent_messages_v1", ["run_id", "created_at"], { ifNotExists: true });

  pgm.addColumns("llm_invocations_v1", {
    knowledge_context_id: { type: "text" },
    knowledge_decision_id: { type: "text" },
    knowledge_tool_execution_ids: { type: "jsonb", notNull: true, default: "[]" },
    boundary_policy_version: { type: "text" },
    knowledge_validation_status: { type: "text", notNull: true, default: "not-applicable" }
  }, { ifNotExists: true });

  for (const table of [
    "llm_knowledge_contexts_v1",
    "knowledge_claims_v1",
    "knowledge_decisions_v1",
    "knowledge_conflicts_v1",
    "knowledge_tool_executions_v1",
    "agent_messages_v1"
  ]) {
    pgm.sql(`
      CREATE TRIGGER ${table}_immutable
      BEFORE UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_proof_mutation();
    `);
  }
};

exports.down = (pgm) => {
  for (const column of [
    "knowledge_validation_status",
    "boundary_policy_version",
    "knowledge_decision_id",
    "knowledge_tool_execution_ids",
    "knowledge_context_id"
  ]) {
    pgm.dropColumn("llm_invocations_v1", column, { ifExists: true });
  }
  for (const table of [
    "agent_messages_v1",
    "knowledge_tool_executions_v1",
    "knowledge_conflicts_v1",
    "knowledge_decisions_v1",
    "knowledge_claims_v1",
    "llm_knowledge_contexts_v1"
  ]) {
    pgm.dropTable(table, { ifExists: true, cascade: true });
  }
};
