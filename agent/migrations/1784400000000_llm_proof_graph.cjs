exports.up = (pgm) => {
  pgm.addColumns("llm_calls_v1", {
    invocation_json: { type: "jsonb", notNull: true, default: "{}" },
    completed_at: { type: "timestamptz" },
    prompt_sha256: { type: "text" },
    graph_version: { type: "text" },
    model_profile_id: { type: "text" },
    price_catalog_version: { type: "text" },
    final_status_impact: { type: "text", notNull: true, default: "none" }
  }, { ifNotExists: true });

  // Keep llm_calls_v1 as the compatibility projection used by historical
  // reports. This table is the lossless, provider-independent invocation
  // ledger for Planner, Judge, Triage, Repair and assistant calls.
  pgm.createTable("llm_invocations_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", references: "runs_v1", onDelete: "CASCADE" },
    experiment_id: { type: "text" },
    purpose: { type: "text", notNull: true },
    provider: { type: "text", notNull: true },
    requested_model: { type: "text", notNull: true },
    returned_model: { type: "text" },
    status: { type: "text", notNull: true },
    prompt_sha256: { type: "text" },
    price_catalog_version: { type: "text" },
    final_status_impact: { type: "text", notNull: true, default: "none" },
    invocation_json: { type: "jsonb", notNull: true },
    started_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("llm_invocations_v1", ["run_id", "started_at"], { ifNotExists: true });
  pgm.createIndex("llm_invocations_v1", ["experiment_id", "purpose"], { ifNotExists: true });

  pgm.createTable("coverage_items_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true, references: "runs_v1", onDelete: "CASCADE" },
    flow_id: { type: "text", notNull: true },
    disposition: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.addConstraint("coverage_items_v1", "coverage_items_run_flow_unique", { unique: ["run_id", "flow_id"] });
  pgm.addConstraint("attempts_v1", "attempts_v1_run_identity_unique", {
    unique: ["id", "run_id"]
  });

  pgm.createTable("conclusions_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true, references: "runs_v1", onDelete: "CASCADE" },
    scenario_id: { type: "text", notNull: true },
    attempt_id: { type: "text", notNull: true },
    claim_type: { type: "text", notNull: true },
    proof_status: { type: "text", notNull: true },
    canonical_sha256: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("conclusions_v1", ["run_id", "claim_type"], { ifNotExists: true });

  pgm.createTable("proof_nodes_v1", {
    id: { type: "text", notNull: true },
    run_id: { type: "text", notNull: true, references: "runs_v1", onDelete: "CASCADE" },
    scenario_id: { type: "text", notNull: true },
    attempt_id: { type: "text", notNull: true },
    node_type: { type: "text", notNull: true },
    canonical_sha256: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.addConstraint("proof_nodes_v1", "proof_nodes_identity_unique", {
    unique: ["id", "run_id", "scenario_id", "attempt_id"]
  });
  pgm.createIndex("proof_nodes_v1", ["run_id", "node_type"], { ifNotExists: true });

  for (const table of ["assertions_v1", "oracles_v1"]) {
    pgm.createTable(table, {
      id: { type: "text", notNull: true },
      run_id: { type: "text", notNull: true, references: "runs_v1", onDelete: "CASCADE" },
      scenario_id: { type: "text", notNull: true },
      attempt_id: { type: "text", notNull: true },
      canonical_sha256: { type: "text", notNull: true },
      payload: { type: "jsonb", notNull: true },
      created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
    }, { ifNotExists: true });
    pgm.addConstraint(table, `${table}_identity_unique`, {
      unique: ["id", "run_id", "scenario_id", "attempt_id"]
    });
  }

  for (const table of ["conclusions_v1", "proof_nodes_v1", "assertions_v1", "oracles_v1"]) {
    pgm.addConstraint(table, `${table}_attempt_fk`, {
      foreignKeys: {
        columns: ["attempt_id", "run_id"],
        references: "attempts_v1(id,run_id)",
        onDelete: "CASCADE",
        deferrable: true,
        deferred: true
      }
    });
  }

  pgm.createTable("proof_edges_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true, references: "runs_v1", onDelete: "CASCADE" },
    scenario_id: { type: "text", notNull: true },
    attempt_id: { type: "text", notNull: true },
    from_type: { type: "text", notNull: true },
    from_id: { type: "text", notNull: true },
    to_type: { type: "text", notNull: true },
    to_id: { type: "text", notNull: true },
    canonical_sha256: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("proof_edges_v1", ["run_id", "from_type", "from_id"], { ifNotExists: true });
  pgm.createIndex("proof_edges_v1", ["run_id", "to_type", "to_id"], { ifNotExists: true });
  pgm.sql(`
    ALTER TABLE proof_edges_v1
      ADD CONSTRAINT proof_edges_from_node_fk
      FOREIGN KEY (from_id,run_id,scenario_id,attempt_id)
      REFERENCES proof_nodes_v1(id,run_id,scenario_id,attempt_id)
      DEFERRABLE INITIALLY DEFERRED;
    ALTER TABLE proof_edges_v1
      ADD CONSTRAINT proof_edges_to_node_fk
      FOREIGN KEY (to_id,run_id,scenario_id,attempt_id)
      REFERENCES proof_nodes_v1(id,run_id,scenario_id,attempt_id)
      DEFERRABLE INITIALLY DEFERRED;
  `);

  pgm.createTable("run_evidence_manifests_v1", {
    run_id: { type: "text", primaryKey: true, references: "runs_v1", onDelete: "CASCADE" },
    evidence_set_root: { type: "text", notNull: true },
    integrity_status: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });

  pgm.createTable("agent_node_executions_v1", {
    id: { type: "text", primaryKey: true },
    run_id: { type: "text", notNull: true, references: "runs_v1", onDelete: "CASCADE" },
    node: { type: "text", notNull: true },
    attempt: { type: "integer", notNull: true },
    input_hash: { type: "text", notNull: true },
    status: { type: "text", notNull: true },
    output: { type: "jsonb", notNull: true, default: "{}" },
    started_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz" }
  }, { ifNotExists: true });
  pgm.addConstraint("agent_node_executions_v1", "agent_node_execution_idempotency", {
    unique: ["run_id", "node", "attempt", "input_hash"]
  });

  pgm.createTable("llm_budget_ledger_v1", {
    run_id: { type: "text", primaryKey: true, references: "runs_v1", onDelete: "CASCADE" },
    payload: { type: "jsonb", notNull: true },
    updated_at: { type: "timestamptz", notNull: true }
  }, { ifNotExists: true });

  pgm.addColumns("runs_v1", {
    run_kind: { type: "text", notNull: true, default: "parent" },
    parent_run_id: { type: "text" },
    coverage_item_id: { type: "text" }
  }, { ifNotExists: true });
  pgm.createIndex("runs_v1", ["parent_run_id", "run_kind"], { ifNotExists: true });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION reject_proof_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'proof_records_are_immutable';
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER conclusions_v1_immutable BEFORE UPDATE OR DELETE ON conclusions_v1
      FOR EACH ROW EXECUTE FUNCTION reject_proof_mutation();
    CREATE TRIGGER proof_nodes_v1_immutable BEFORE UPDATE OR DELETE ON proof_nodes_v1
      FOR EACH ROW EXECUTE FUNCTION reject_proof_mutation();
    CREATE TRIGGER proof_edges_v1_immutable BEFORE UPDATE OR DELETE ON proof_edges_v1
      FOR EACH ROW EXECUTE FUNCTION reject_proof_mutation();
  `);
};

exports.down = (pgm) => {
  for (const table of [
    "llm_budget_ledger_v1",
    "llm_invocations_v1",
    "agent_node_executions_v1",
    "run_evidence_manifests_v1",
    "proof_edges_v1",
    "oracles_v1",
    "assertions_v1",
    "proof_nodes_v1",
    "conclusions_v1",
    "coverage_items_v1"
  ]) pgm.dropTable(table, { ifExists: true, cascade: true });
  for (const column of ["coverage_item_id", "parent_run_id", "run_kind"]) {
    pgm.dropColumn("runs_v1", column, { ifExists: true });
  }
  pgm.sql("DROP FUNCTION IF EXISTS reject_proof_mutation() CASCADE;");
  for (const column of [
    "invocation_json",
    "completed_at",
    "prompt_sha256",
    "graph_version",
    "model_profile_id",
    "price_catalog_version",
    "final_status_impact"
  ]) pgm.dropColumn("llm_calls_v1", column, { ifExists: true });
};
