exports.up = (pgm) => {
  pgm.createTable("reliability_assets_v1", {
    kind: { type: "text", notNull: true },
    asset_id: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.addConstraint("reliability_assets_v1", "reliability_assets_v1_pk", { primaryKey: ["kind", "asset_id"] });
  pgm.createIndex("reliability_assets_v1", ["kind", "updated_at"], { ifNotExists: true });
  pgm.createTable("reliability_asset_evidence_v1", {
    evidence_id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });
  pgm.createIndex("reliability_asset_evidence_v1", ["run_id", "created_at", "evidence_id"], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable("reliability_asset_evidence_v1", { ifExists: true });
  pgm.dropTable("reliability_assets_v1", { ifExists: true });
};
