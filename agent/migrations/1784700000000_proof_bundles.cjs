// P0.2 — authoritative credibility ledger.
//
// Every verified machine gate minted by the Proof Bundle Service
// (agent/src/proof/proofBundleService.ts) can be persisted here, bound to the
// exact (run_id, attempt_id) that produced it. The foreign key to attempts_v1
// plus the immutability trigger make this the single tamper-evident record of
// "who asserted what credibility, for which attempt".
exports.up = (pgm) => {
  pgm.createTable("proof_bundles_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true, references: "runs_v1", onDelete: "CASCADE" },
    attempt_id: { type: "text" },
    scenario_id: { type: "text" },
    status: { type: "text", notNull: true },
    reasons: { type: "jsonb", notNull: true, default: "[]" },
    reason_details: { type: "jsonb", notNull: true, default: "[]" },
    assertion_failures: { type: "jsonb", notNull: true, default: "[]" },
    evidence_complete: { type: "boolean", notNull: true, default: false },
    artifact_integrity_verified: { type: "boolean", notNull: true, default: false },
    evidence_grounded: { type: "boolean", notNull: true, default: false },
    gate_eligible: { type: "boolean", notNull: true, default: false },
    proof_bundle_id: { type: "text", notNull: true },
    proof_validation_version: { type: "text", notNull: true },
    canonical_sha256: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true, default: "{}" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });

  // One authoritative credibility record per (run, attempt). A second write for
  // the same attempt is rejected, so a re-run / shadow cannot overwrite a
  // sibling attempt's verified gate.
  pgm.addConstraint("proof_bundles_v1", "proof_bundles_run_attempt_unique", {
    unique: ["run_id", "attempt_id"]
  });

  // P0-14 — an attempt-scoped gate MUST name its attempt.
  //
  // `attempt_id` stays nullable only because a run-level aggregate gate (the
  // parent run re-minting its own verdict over child attempts) has no single
  // attempt. That case must be declared, not inferred from a NULL: a NULL that
  // merely means "we lost the attempt id" would let an unbound gate masquerade
  // as an aggregate and escape the (attempt_id, run_id) foreign key.
  pgm.sql(`
    ALTER TABLE proof_bundles_v1
      ADD COLUMN IF NOT EXISTS aggregate_attempt boolean NOT NULL DEFAULT false;

    -- Legacy rows without an attempt id can only be aggregates; mark them so
    -- the CHECK below can be enforced without dropping credibility history.
    UPDATE proof_bundles_v1 SET aggregate_attempt = true WHERE attempt_id IS NULL;

    ALTER TABLE proof_bundles_v1 DROP CONSTRAINT IF EXISTS proof_bundles_attempt_scope_check;
    ALTER TABLE proof_bundles_v1 ADD CONSTRAINT proof_bundles_attempt_scope_check
      CHECK (
        (aggregate_attempt = false AND attempt_id IS NOT NULL)
        OR (aggregate_attempt = true AND attempt_id IS NULL)
      );

    -- Unique(run_id, attempt_id) does not constrain NULLs in PostgreSQL, so the
    -- aggregate row needs its own single-row-per-run guarantee.
    CREATE UNIQUE INDEX IF NOT EXISTS proof_bundles_run_aggregate_unique
      ON proof_bundles_v1 (run_id) WHERE aggregate_attempt;
  `);

  // Bind the ledger row to a real attempt of THIS run. PostgreSQL ignores the
  // FK when attempt_id is NULL, so run-level (aggregate) gates may omit it, but
  // any attempt-scoped gate must reference an attempt that belongs to run_id.
  pgm.addConstraint("proof_bundles_v1", "proof_bundles_attempt_fk", {
    foreignKeys: {
      columns: ["attempt_id", "run_id"],
      references: "attempts_v1(id,run_id)",
      onDelete: "CASCADE",
      deferrable: true,
      deferred: true
    }
  });

  pgm.createIndex("proof_bundles_v1", ["run_id", "proof_validation_version"], { ifNotExists: true });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION reject_proof_bundle_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'proof_bundle_records_are_immutable';
    END;
    $$ LANGUAGE plpgsql;

    -- Idempotent on re-runs: a second migration pass (or a restart of the
    -- migration command) must not fail because the trigger already exists.
    DROP TRIGGER IF EXISTS proof_bundles_v1_immutable ON proof_bundles_v1;
    CREATE TRIGGER proof_bundles_v1_immutable BEFORE UPDATE OR DELETE ON proof_bundles_v1
      FOR EACH ROW EXECUTE FUNCTION reject_proof_bundle_mutation();
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP FUNCTION IF EXISTS reject_proof_bundle_mutation() CASCADE;");
  pgm.dropTable("proof_bundles_v1", { ifExists: true, cascade: true });
};
