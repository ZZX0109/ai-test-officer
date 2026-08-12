exports.up = (pgm) => {
  pgm.createTable("planning_inventories_v1", {
    id: { type: "text", primaryKey: true },
    project_id: { type: "text", notNull: true },
    snapshot_hash: { type: "text" },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("planning_inventories_v1", ["project_id", "created_at"], { ifNotExists: true });
};

exports.down = (pgm) => pgm.dropTable("planning_inventories_v1", { ifExists: true });
