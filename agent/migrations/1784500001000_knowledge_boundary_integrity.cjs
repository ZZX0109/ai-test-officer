exports.up = (pgm) => {
  pgm.createExtension("pgcrypto", { ifNotExists: true });
  pgm.addColumns("knowledge_tool_executions_v1", {
    canonical_sha256: { type: "text" }
  }, { ifNotExists: true });
  pgm.addColumns("agent_messages_v1", {
    canonical_sha256: { type: "text" }
  }, { ifNotExists: true });
  pgm.sql(`
    UPDATE knowledge_tool_executions_v1
    SET canonical_sha256 = encode(digest(payload::text, 'sha256'), 'hex')
    WHERE canonical_sha256 IS NULL;
    UPDATE agent_messages_v1
    SET canonical_sha256 = encode(digest(payload::text, 'sha256'), 'hex')
    WHERE canonical_sha256 IS NULL;
    ALTER TABLE knowledge_tool_executions_v1
      ALTER COLUMN canonical_sha256 SET NOT NULL;
    ALTER TABLE agent_messages_v1
      ALTER COLUMN canonical_sha256 SET NOT NULL;
    DROP TRIGGER IF EXISTS knowledge_tool_executions_v1_immutable
      ON knowledge_tool_executions_v1;
    CREATE TRIGGER knowledge_tool_executions_v1_immutable
      BEFORE UPDATE OR DELETE ON knowledge_tool_executions_v1
      FOR EACH ROW EXECUTE FUNCTION reject_proof_mutation();
    DROP TRIGGER IF EXISTS agent_messages_v1_immutable
      ON agent_messages_v1;
    CREATE TRIGGER agent_messages_v1_immutable
      BEFORE UPDATE OR DELETE ON agent_messages_v1
      FOR EACH ROW EXECUTE FUNCTION reject_proof_mutation();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS agent_messages_v1_immutable ON agent_messages_v1;
    DROP TRIGGER IF EXISTS knowledge_tool_executions_v1_immutable
      ON knowledge_tool_executions_v1;
  `);
  pgm.dropColumn("agent_messages_v1", "canonical_sha256", { ifExists: true });
  pgm.dropColumn("knowledge_tool_executions_v1", "canonical_sha256", { ifExists: true });
};
