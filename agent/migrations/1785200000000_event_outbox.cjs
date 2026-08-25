exports.up = (pgm) => {
  pgm.createTable("event_outbox_v1", {
    id: { type: "text", primaryKey: true },
    topic: { type: "text", notNull: true },
    aggregate_id: { type: "text", notNull: true },
    idempotency_key: { type: "text", notNull: true, unique: true },
    payload: { type: "jsonb", notNull: true },
    status: { type: "text", notNull: true, default: "pending" },
    attempts: { type: "integer", notNull: true, default: 0 },
    available_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    last_error: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    published_at: { type: "timestamptz" }
  }, { ifNotExists: true });
  pgm.createIndex("event_outbox_v1", ["status", "available_at", "created_at"], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable("event_outbox_v1", { ifExists: true });
};
