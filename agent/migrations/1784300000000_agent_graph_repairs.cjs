exports.up = (pgm) => {
  pgm.createSchema("langgraph", { ifNotExists: true });
  pgm.createTable("agent_graph_projections_v1", {
    run_id: { type: "text", primaryKey: true },
    projection: { type: "jsonb", notNull: true },
    updated_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createTable("repair_sessions_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true },
    project_id: { type: "text", notNull: true },
    status: { type: "text", notNull: true },
    session_json: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("repair_sessions_v1", ["run_id", "created_at"], { ifNotExists: true });
  pgm.createTable("repair_exports_v1", {
    id: { type: "text", primaryKey: true },
    repair_session_id: { type: "text", notNull: true },
    export_json: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("repair_exports_v1", "repair_session_id", { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable("repair_exports_v1", { ifExists: true, cascade: true });
  pgm.dropTable("repair_sessions_v1", { ifExists: true, cascade: true });
  pgm.dropTable("agent_graph_projections_v1", { ifExists: true, cascade: true });
  pgm.dropSchema("langgraph", { ifExists: true, cascade: true });
};
