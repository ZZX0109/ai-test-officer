exports.up = (pgm) => {
  pgm.createTable("project_memory_entries_v1", {
    entry_id: { type: "text", primaryKey: true },
    project_id: { type: "text", notNull: true },
    category: { type: "text", notNull: true },
    memory_key: { type: "text", notNull: true },
    verified: { type: "boolean", notNull: true, default: false },
    payload: { type: "jsonb", notNull: true },
    updated_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("project_memory_entries_v1", ["project_id", "category", "memory_key"], { ifNotExists: true });

  pgm.createTable("experience_memory_entries_v1", {
    entry_id: { type: "text", primaryKey: true },
    project_id: { type: "text", notNull: true },
    failure_type: { type: "text", notNull: true },
    repair_strategy: { type: "text", notNull: true },
    validation_result: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    updated_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("experience_memory_entries_v1", ["project_id", "failure_type", "repair_strategy"], { ifNotExists: true });

  pgm.createTable("trace_chains_v1", {
    trace_id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true },
    project_id: { type: "text" },
    active: { type: "boolean", notNull: true, default: true },
    payload: { type: "jsonb", notNull: true },
    updated_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("trace_chains_v1", ["run_id", "active"], { ifNotExists: true });

  pgm.createTable("trace_spans_v1", {
    span_id: { type: "text", primaryKey: true },
    trace_id: { type: "text", notNull: true, references: "trace_chains_v1", onDelete: "CASCADE" },
    run_id: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    started_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("trace_spans_v1", ["trace_id", "started_at"], { ifNotExists: true });

  pgm.createTable("feedback_loop_sessions_v1", {
    session_id: { type: "text", primaryKey: true },
    project_id: { type: "text", notNull: true },
    run_id: { type: "text" },
    stage: { type: "text", notNull: true },
    closed: { type: "boolean", notNull: true, default: false },
    payload: { type: "jsonb", notNull: true },
    updated_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("feedback_loop_sessions_v1", ["project_id", "closed", "updated_at"], { ifNotExists: true });
  pgm.createIndex("feedback_loop_sessions_v1", ["run_id"], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable("feedback_loop_sessions_v1", { ifExists: true });
  pgm.dropTable("trace_spans_v1", { ifExists: true });
  pgm.dropTable("trace_chains_v1", { ifExists: true });
  pgm.dropTable("experience_memory_entries_v1", { ifExists: true });
  pgm.dropTable("project_memory_entries_v1", { ifExists: true });
};
