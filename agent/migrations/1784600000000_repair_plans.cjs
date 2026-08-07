// P0-13 — owner-aware repair plans, bound to the run/attempt they explain.
//
// A repair plan is a *commitment*: it names who owns the failure and what the
// user may press. That only holds if the row cannot be orphaned (FK), cannot
// carry an owner/type the code never produces (CHECK), cannot be duplicated by
// a graph restart (idempotency_key UNIQUE), and cannot be silently rewritten
// after the fact (append-only trigger, status-only transitions).
//
// The column set must stay in sync with `persistRepairPlan()` in
// agent/src/repairPlan.ts — a 21-column INSERT against a 16-column table fails
// at runtime and silently degrades an explained failure into an unexplained one.
//
// This migration is written idempotently (ADD COLUMN IF NOT EXISTS / DROP+ADD
// CONSTRAINT) because the first revision of the table already shipped without
// the binding columns; a database created from it must converge here rather
// than skip the new constraints via `ifNotExists`.
exports.up = (pgm) => {
  // `sha256()` is provided by the pgcrypto extension. Guarantee it exists before
  // the backfill below relies on it, so the migration cannot fail on a fresh
  // PostgreSQL that does not have pgcrypto enabled by default.
  pgm.sql("CREATE EXTENSION IF NOT EXISTS pgcrypto;");

  pgm.createTable("repair_plans_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true },
    project_id: { type: "text" },
    attribution_id: { type: "text" },
    failure_type: { type: "text", notNull: true },
    owner: { type: "text", notNull: true },
    repair_type: { type: "text", notNull: true },
    executable: { type: "boolean", notNull: true, default: false },
    problem: { type: "text" },
    user_message: { type: "text" },
    steps: { type: "jsonb", notNull: true, default: pgm.func("'[]'::jsonb") },
    validation: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    status: { type: "text", notNull: true, default: "pending" },
    canonical_sha256: { type: "text" },
    created_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });

  pgm.sql(`
    -- Attempt/scenario binding: without it the panel can describe a repair but
    -- cannot say which execution it applies to, so "重试" has no target.
    ALTER TABLE repair_plans_v1 ADD COLUMN IF NOT EXISTS attempt_id text;
    ALTER TABLE repair_plans_v1 ADD COLUMN IF NOT EXISTS scenario_id text;
    ALTER TABLE repair_plans_v1 ADD COLUMN IF NOT EXISTS evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE repair_plans_v1 ADD COLUMN IF NOT EXISTS policy_version text;
    ALTER TABLE repair_plans_v1 ADD COLUMN IF NOT EXISTS idempotency_key text;

    -- A plan without a canonical digest cannot be shown to be the same plan the
    -- graph committed, which defeats the point of persisting it. Backfill the
    -- legacy rows before enforcing NOT NULL so the migration cannot fail half-way.
    UPDATE repair_plans_v1
      SET canonical_sha256 = encode(sha256(convert_to(
            coalesce(id,'') || '|' || coalesce(run_id,'') || '|' || coalesce(repair_type,''), 'UTF8')), 'hex')
      WHERE canonical_sha256 IS NULL;
    ALTER TABLE repair_plans_v1 ALTER COLUMN canonical_sha256 SET NOT NULL;
  `);

  pgm.sql(`
    ALTER TABLE repair_plans_v1 DROP CONSTRAINT IF EXISTS repair_plans_run_fk;
    ALTER TABLE repair_plans_v1 ADD CONSTRAINT repair_plans_run_fk
      FOREIGN KEY (run_id) REFERENCES runs_v1(id) ON DELETE CASCADE;

    -- Attempt-scoped plans must reference an attempt of THIS run. PostgreSQL
    -- skips the FK when attempt_id IS NULL, so run-level plans (produced before
    -- any attempt exists, e.g. discovery-time credential blocks) stay legal.
    ALTER TABLE repair_plans_v1 DROP CONSTRAINT IF EXISTS repair_plans_attempt_fk;
    ALTER TABLE repair_plans_v1 ADD CONSTRAINT repair_plans_attempt_fk
      FOREIGN KEY (attempt_id, run_id) REFERENCES attempts_v1(id, run_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

    -- Owner is the safety boundary: a suspected product defect must never be
    -- owned by the agent, because acting on it means editing product source.
    ALTER TABLE repair_plans_v1 DROP CONSTRAINT IF EXISTS repair_plans_owner_check;
    ALTER TABLE repair_plans_v1 ADD CONSTRAINT repair_plans_owner_check
      CHECK (owner IN ('agent','user','environment','developer'));

    ALTER TABLE repair_plans_v1 DROP CONSTRAINT IF EXISTS repair_plans_type_check;
    ALTER TABLE repair_plans_v1 ADD CONSTRAINT repair_plans_type_check
      CHECK (repair_type IN (
        'update_selector','selector_drift','provide_credential','credential_required',
        'fix_environment','runtime_unavailable','discovery_incomplete',
        'modify_code','product_bug','evidence_missing','manual_review'
      ));

    ALTER TABLE repair_plans_v1 DROP CONSTRAINT IF EXISTS repair_plans_status_check;
    ALTER TABLE repair_plans_v1 ADD CONSTRAINT repair_plans_status_check
      CHECK (status IN ('pending','applied','resolved','dismissed'));

    -- executable === (owner === 'agent') is the invariant decideRepair() encodes.
    ALTER TABLE repair_plans_v1 DROP CONSTRAINT IF EXISTS repair_plans_executable_owner_check;
    ALTER TABLE repair_plans_v1 ADD CONSTRAINT repair_plans_executable_owner_check
      CHECK (executable = false OR owner = 'agent');

    ALTER TABLE repair_plans_v1 DROP CONSTRAINT IF EXISTS repair_plans_product_bug_owner_check;
    ALTER TABLE repair_plans_v1 ADD CONSTRAINT repair_plans_product_bug_owner_check
      CHECK (repair_type NOT IN ('product_bug','modify_code') OR owner = 'developer');

    -- A graph re-entry (restart / resumed interrupt) recomputes the same plan.
    -- The idempotency key makes the second write a no-op instead of a duplicate
    -- that would double-count in the feedback loop.
    CREATE UNIQUE INDEX IF NOT EXISTS repair_plans_idempotency_unique
      ON repair_plans_v1 (idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);

  pgm.createIndex("repair_plans_v1", ["run_id", "created_at"], { ifNotExists: true });
  pgm.createIndex("repair_plans_v1", ["project_id", "failure_type"], { ifNotExists: true });
  pgm.createIndex("repair_plans_v1", "status", { ifNotExists: true });
  pgm.createIndex("repair_plans_v1", ["attempt_id"], { ifNotExists: true });

  // Append-only with a status lifecycle: `status`/`updated_at` may advance, the
  // decision itself may not be rewritten, and rows may never be deleted.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION reject_repair_plan_rewrite() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'repair_plan_records_are_append_only';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.run_id IS DISTINCT FROM OLD.run_id
        OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
        OR NEW.scenario_id IS DISTINCT FROM OLD.scenario_id
        OR NEW.failure_type IS DISTINCT FROM OLD.failure_type
        OR NEW.owner IS DISTINCT FROM OLD.owner
        OR NEW.repair_type IS DISTINCT FROM OLD.repair_type
        OR NEW.executable IS DISTINCT FROM OLD.executable
        OR NEW.problem IS DISTINCT FROM OLD.problem
        OR NEW.user_message IS DISTINCT FROM OLD.user_message
        OR NEW.steps IS DISTINCT FROM OLD.steps
        OR NEW.validation IS DISTINCT FROM OLD.validation
        OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs
        OR NEW.canonical_sha256 IS DISTINCT FROM OLD.canonical_sha256
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      THEN
        RAISE EXCEPTION 'repair_plan_decision_is_immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS repair_plans_v1_append_only ON repair_plans_v1;
    CREATE TRIGGER repair_plans_v1_append_only BEFORE UPDATE OR DELETE ON repair_plans_v1
      FOR EACH ROW EXECUTE FUNCTION reject_repair_plan_rewrite();
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP FUNCTION IF EXISTS reject_repair_plan_rewrite() CASCADE;");
  pgm.dropTable("repair_plans_v1", { ifExists: true, cascade: true });
};
