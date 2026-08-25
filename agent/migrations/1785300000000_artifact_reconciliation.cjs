exports.up = (pgm) => {
  pgm.createTable("artifact_reconciliation_v1", {
    artifact_id: { type: "text", primaryKey: true, references: "artifacts_v1", onDelete: "CASCADE" },
    run_id: { type: "text", notNull: true, references: "runs_v1", onDelete: "CASCADE" },
    object_uri: { type: "text", notNull: true },
    state: { type: "text", notNull: true },
    detail: { type: "text" },
    reconciled_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("artifact_reconciliation_v1", ["run_id", "state"], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable("artifact_reconciliation_v1", { ifExists: true, cascade: true });
};
