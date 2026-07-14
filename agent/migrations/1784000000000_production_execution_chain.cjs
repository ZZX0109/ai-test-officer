exports.up = (pgm) => {
  pgm.createTable("organizations", { id: { type: "text", primaryKey: true }, name: { type: "text", notNull: true }, created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") } }, { ifNotExists: true });
  pgm.createTable("projects_v1", { id: { type: "text", primaryKey: true }, organization_id: { type: "text", notNull: true }, manifest: { type: "jsonb", notNull: true }, created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") } }, { ifNotExists: true });
  pgm.createTable("runs_v1", { id: { type: "text", primaryKey: true }, organization_id: { type: "text", notNull: true }, project_id: { type: "text" }, state: { type: "text", notNull: true }, version: { type: "integer", notNull: true }, input: { type: "jsonb", notNull: true }, final_status: { type: "text" }, created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }, updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") } }, { ifNotExists: true });
  for (const table of ["run_events_v1", "plans_v1", "permissions_v1", "attempts_v1", "evidence_v1", "artifacts_v1", "judge_results_v1", "human_decisions_v1", "notification_deliveries_v1"]) {
    pgm.createTable(table, { id: { type: "text", primaryKey: true }, run_id: { type: "text", notNull: true }, payload: { type: "jsonb", notNull: true }, created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") } }, { ifNotExists: true });
    pgm.createIndex(table, "run_id", { ifNotExists: true });
  }
  pgm.createTable("execution_leases", { run_id: { type: "text", primaryKey: true }, worker_id: { type: "text", notNull: true }, attempt_id: { type: "text", notNull: true }, lease_until: { type: "timestamptz", notNull: true }, heartbeat_at: { type: "timestamptz", notNull: true } }, { ifNotExists: true });
  pgm.createTable("patrol_schedules_v1", { id: { type: "text", primaryKey: true }, organization_id: { type: "text", notNull: true }, project_id: { type: "text", notNull: true }, next_run_at: { type: "timestamptz", notNull: true }, failure_count: { type: "integer", notNull: true, default: 0 }, backoff_until: { type: "timestamptz" }, lease_until: { type: "timestamptz" }, notification_state: { type: "jsonb", notNull: true, default: "{}" } }, { ifNotExists: true });
};

exports.down = (pgm) => {
  for (const table of ["patrol_schedules_v1", "execution_leases", "notification_deliveries_v1", "human_decisions_v1", "judge_results_v1", "artifacts_v1", "evidence_v1", "attempts_v1", "permissions_v1", "plans_v1", "run_events_v1", "runs_v1", "projects_v1", "organizations"]) pgm.dropTable(table, { ifExists: true, cascade: true });
};
