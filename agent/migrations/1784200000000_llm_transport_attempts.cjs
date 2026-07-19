exports.up = (pgm) => {
  pgm.addColumn("llm_calls_v1", {
    transport_attempts: { type: "jsonb", notNull: true, default: "[]" }
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropColumn("llm_calls_v1", "transport_attempts", { ifExists: true });
};
