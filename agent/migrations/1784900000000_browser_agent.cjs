exports.up = (pgm) => {
  pgm.createTable("browser_sessions_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true, unique: true },
    attempt_id: { type: "text", notNull: true },
    owner: { type: "text", notNull: true },
    status: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    updated_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createTable("browser_observations_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true },
    attempt_id: { type: "text", notNull: true },
    coverage_item_id: { type: "text" },
    page_fingerprint: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createTable("browser_action_decisions_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true },
    attempt_id: { type: "text", notNull: true },
    observation_id: { type: "text", notNull: true },
    status: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createTable("browser_action_results_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true },
    attempt_id: { type: "text", notNull: true },
    coverage_item_id: { type: "text", notNull: true },
    action_id: { type: "text", notNull: true },
    status: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    completed_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("browser_observations_v1", ["run_id", "attempt_id", "created_at"], { ifNotExists: true });
  pgm.createIndex("browser_action_decisions_v1", ["run_id", "attempt_id", "created_at"], { ifNotExists: true });
  pgm.createIndex("browser_action_results_v1", ["run_id", "attempt_id", "completed_at"], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable("browser_action_results_v1", { ifExists: true });
  pgm.dropTable("browser_action_decisions_v1", { ifExists: true });
  pgm.dropTable("browser_observations_v1", { ifExists: true });
  pgm.dropTable("browser_sessions_v1", { ifExists: true });
};
