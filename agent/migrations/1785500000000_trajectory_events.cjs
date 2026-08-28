/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('trajectory_events', {
    id: { type: 'text', primaryKey: true },
    run_id: { type: 'text', notNull: true },
    seq: { type: 'integer', notNull: true },
    run_seq: { type: 'integer', notNull: true },
    root_run_id: { type: 'text', notNull: true },
    root_seq: { type: 'bigint', notNull: true },
    parent_run_id: { type: 'text' },
    type: { type: 'text', notNull: true },
    at: { type: 'timestamptz', notNull: true },
    actor: { type: 'text', notNull: true },
    turn_id: { type: 'text' },
    step_id: { type: 'text' },
    attempt_id: { type: 'text' },
    trace_id: { type: 'text' },
    parent_event_id: { type: 'text' },
    span_id: { type: 'text' },
    parent_span_id: { type: 'text' },
    status: { type: 'text' },
    usage: { type: 'jsonb' },
    timing: { type: 'jsonb' },
    visibility: { type: 'text', notNull: true, default: 'user' },
    idempotency_key: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    evidence_refs: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") }
  });
  pgm.addConstraint('trajectory_events', 'trajectory_events_run_seq_key', { unique: ['run_id', 'seq'] });
  pgm.addConstraint('trajectory_events', 'trajectory_events_run_idempotency_key', { unique: ['run_id', 'idempotency_key'] });
  pgm.createIndex('trajectory_events', ['run_id', 'seq'], { name: 'idx_trajectory_events_run_seq' });
  pgm.createIndex('trajectory_events', ['root_run_id', 'root_seq'], { name: 'idx_trajectory_events_root_seq' });
  pgm.createTable('trajectory_root_sequences', {
    root_run_id: { type: 'text', primaryKey: true },
    root_seq: { type: 'bigint', notNull: true }
  });
  pgm.sql(`CREATE OR REPLACE FUNCTION trajectory_events_append_only() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'trajectory_events_append_only'; END; $$ LANGUAGE plpgsql;`);
  pgm.sql(`CREATE TRIGGER trajectory_events_no_update BEFORE UPDATE ON trajectory_events FOR EACH ROW EXECUTE FUNCTION trajectory_events_append_only();`);
  pgm.sql(`CREATE TRIGGER trajectory_events_no_delete BEFORE DELETE ON trajectory_events FOR EACH ROW EXECUTE FUNCTION trajectory_events_append_only();`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS trajectory_events_no_update ON trajectory_events; DROP TRIGGER IF EXISTS trajectory_events_no_delete ON trajectory_events; DROP FUNCTION IF EXISTS trajectory_events_append_only();`);
  pgm.dropTable('trajectory_root_sequences');
  pgm.dropTable('trajectory_events');
};
