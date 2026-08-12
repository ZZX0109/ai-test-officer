exports.up = (pgm) => {
  pgm.createTable("agent_route_decisions_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true },
    coverage_item_id: { type: "text" },
    attempt_id: { type: "text" },
    action: { type: "text", notNull: true },
    decision: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createTable("agent_recovery_actions_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true },
    decision_id: { type: "text", notNull: true },
    action: { type: "text", notNull: true },
    status: { type: "text", notNull: true },
    evidence_refs: { type: "jsonb", notNull: true, default: "[]" },
    result: { type: "jsonb", notNull: true, default: "{}" },
    started_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz" }
  }, { ifNotExists: true });
  pgm.createTable("agent_observations_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true },
    attempt_id: { type: "text" },
    stage: { type: "text", notNull: true },
    status: { type: "text", notNull: true },
    observation: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("agent_route_decisions_v1", ["run_id", "created_at"], { ifNotExists: true });
  pgm.createIndex("agent_recovery_actions_v1", ["run_id", "started_at"], { ifNotExists: true });
  pgm.createIndex("agent_observations_v1", ["run_id", "created_at"], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable("agent_observations_v1", { ifExists: true });
  pgm.dropTable("agent_recovery_actions_v1", { ifExists: true });
  pgm.dropTable("agent_route_decisions_v1", { ifExists: true });
};
