exports.up = (pgm) => {
  pgm.createTable("project_grants_v1", {
    id: { type: "text", primaryKey: true },
    project_id: { type: "text", notNull: true },
    subject: { type: "text", notNull: true },
    grant_json: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("project_grants_v1", ["project_id", "subject"], { ifNotExists: true });
};

exports.down = (pgm) => pgm.dropTable("project_grants_v1", { ifExists: true, cascade: true });
