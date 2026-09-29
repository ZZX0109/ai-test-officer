# Reviewer Handoff

This repository snapshot is intended for an external model or engineer to
review the AI Test Officer architecture and reliability changes.

Use `npm run package:review` to create the review archive. It verifies that
the archive contains the current low-sensitivity verification reports
(Production acceptance, Shadow Graph, clean Linux baseline, external acceptance
audit, capacity, repair, red-team and SLO reports)
and contains no dependency/build cache, `.env`, blind labels or AppleDouble files.
When the target text is outside the repository, set
`REVIEW_REQUIREMENTS_SOURCE=/absolute/path/to/requirements.txt`; the exact
source is then included at the archive root for an external reviewer.

## Included

- TypeScript source under `agent/`, `packages/`, `workbench-ui/` and `app-under-test/`
- Unit, contract, worker and browser smoke tests
- `package.json`, `package-lock.json`, migration files and deployment manifests
- `.env.example`, `config/config.example.json`, acceptance locks and project manifests
- Architecture, reliability, security, benchmark and data-ownership documents
- `docs/current-completion-audit.md` and adversarial Proof Bundle tests
- `reports/capacity-control-plane/latest.json` is included as a clearly labelled control-plane-only scale check; it is not a production capacity claim.
- Data-service, worker and browser load reports are included with their own scope limits; they do not combine into an end-to-end production capacity claim.
- `reports/fault-injection/latest.json` and `.md` are included as a mapped 14-boundary isolated-Compose recovery audit; they are not a sustained production SLO or external-project fault report.
- `reports/security-adversarial/latest.json` and the three `reports/redteam/` probes are included as isolated security evidence; they are not a sustained production multi-tenant red-team report.
- `reports/external-acceptance/` includes the five locked-project provenance and lane records. The current fail-closed audit is `NOT READY`: no independent evaluator report is supplied and the recorded non-native lanes are not terminal sealed-evaluation results.
- `reports/external-repair/latest.json` is included so its blocked/failed validations are reviewable; it is not successful production Repair proof.
- `reports/production-slo/latest.json` is included with generated stack secrets removed. It records one disposable Compose measurement, not a persistent production deployment.

## Deliberately excluded

- `node_modules/`
- `agent/dist/`, `workbench-ui/dist/`, `app-under-test/dist/`
- local coverage/cache output, evaluator labels/unseal keys and reports outside the allowlisted latest
  verification reports included with this reviewer snapshot
- `.git/`
- `.env` and local credential/secret files under `config/`

## Suggested review order

1. `README.md` and `docs/architecture-one-page.md`
2. `agent/src/agentGraphService.ts`, `agent/src/runOrchestrator.ts`, `packages/agent-orchestration/src/index.ts`, `packages/agent-orchestration/src/state.ts`, `packages/agent-orchestration/src/graphNodes.ts` and `packages/agent-orchestration/src/subgraphs.ts`
3. `agent/src/coverageStore.ts`, `agent/src/runtimeBinding.ts` and `agent/src/parentRunEvidence.ts`
4. `agent/src/runEventStore.ts`, `agent/src/outboxStore.ts` and `agent/src/databaseRuntime.ts`
5. `agent/src/proof/`, `agent/src/executionPersistence.ts` and `agent/src/browser-agent/`
6. `scripts/baseline-verification.mjs`, `scripts/production-acceptance.mjs` and `scripts/external-project-preflight.mjs`
7. Tests named in the changed-file list and the benchmark/evaluation documents

The typed-subgraph implementation and its current verification boundary are
described in [Typed Subgraph Boundaries](typed-subgraphs.md). The current
100-run Shadow Graph summary is included as `reports/shadow-graph/latest.json`;
rerun `npm run shadow:run` when reviewing a changed checkout.

## Local verification

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run baseline:verify
npm run memory:eval:dataset
npm run capacity:control-plane
```

The current code explicitly labels memory retrieval as `hybrid-embedding-v1`
when an embedding provider is configured, and `keyword-v1` otherwise; it never
uses a deterministic hash as a semantic substitute. Structured
manifest paths and executable dynamic page paths have per-path child runs and
outbox-backed parent dispatch. Runtime binding for dynamic controls still
finishes during the child Observation phase; unbound non-page candidates remain
explicit gaps rather than being silently dropped.

The repository includes a 50-query memory label set at
`data/memory/retrieval-eval-v1.json`. The dataset check reports
`providerRun: required`; it validates the sealed labels but does not claim
semantic retrieval quality.

External project profiles use `${ENV_ROOT}` path templates (for example
`ANDFLOW_PROJECT_ROOT`) instead of developer-specific absolute paths. Set the
corresponding variable before running that profile; an unset root is rejected
at project start.

The locked-project preflight is opt-in and host-command execution is disabled
by default. In a disposable checkout only, run
`EXTERNAL_ACCEPTANCE_ROOT=/path/to/checkouts EXTERNAL_ACCEPTANCE_ALLOW_HOST_COMMANDS=1 npm run acceptance:external:preflight`.
It records provenance and native checks but never upgrades an external project
to completed without sealed evaluator evidence.

For a requirement-by-requirement audit, including evidence strength and
remaining external gates, see [当前目标书逐项审计](current-completion-audit.md).
