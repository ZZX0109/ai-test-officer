# External Reviewer Snapshot — 2026-08-24

This is a source snapshot for an external model or engineer reviewing the
current AI Test Officer architecture and reliability work.

## Provenance

- Base Git revision: `479ca2a0c59e`.
- This snapshot includes the current working tree, which has local
  modifications and untracked files. It is intentionally **not** presented as
  a single-commit release artifact.
- The package includes the redacted production acceptance summary at
  `reports/production-acceptance/latest.json`. Its SHA-256 is
  `3157d1999889fc5a8f39e2ca34f8e5cd02678fcab801288e74ecf8e487a493f9`.

## Verified in this workspace

- The isolated Production Compose acceptance suite passed 45 checks on
  2026-08-24, including OIDC/org isolation, durable Outbox delivery, Artifact
  v2 S3 commit, reconciliation, Redis/MinIO/PostgreSQL recovery, API/Worker
  restarts, lease takeover, a Worker `SIGKILL` recovery with a durable
  `worker_lease_expired` event and one terminal Child Run outcome, plus a
  post-`run_judging` Worker `SIGKILL` that recovers from the persisted Gate and
  replays it to a newly connected SSE client, plus an API `SIGKILL` immediately
  after `plan_approved` that resumes the durable Graph to browser permission
  without duplicating approval or granting capability automatically. It also
  hard-kills a Worker after each Artifact object boundary: temporary upload,
  temporary-object integrity verification, and final S3 object verification
  before the Artifact ledger write. Each recovery completes through a new
  Attempt and reconciliation removes the corresponding orphan; the final
  object is additionally proven not to be adopted as evidence. A real BullMQ
  stale generation plus delayed current-generation delivery is also proven not
  to create a second Child Run or change the terminal projection. Finally, a
  mutable API target is paused after its successful write but before the local
  PostgreSQL execution receipt is completed; an API `SIGKILL` at that point and
  a same-identity retry leave exactly one target-side write and complete the
  durable receipt.
- `npm run lint -- --quiet`, `npm run size-guard`, `npm run quality:contracts`,
  `npm --workspace @ai-test-officer/agent run typecheck`, and `git diff --check`
  passed on this snapshot.

## Review boundaries

Do not infer that all resilience or model-quality claims are proven from the
evidence above. The precise failure boundaries and their evidence are
maintained in `docs/fault-injection-matrix.md`.

External generalisation is also not proven: the sealed external-project audit
requires five heterogeneous projects (React/Vite, Next.js, FastAPI,
Java/Spring, and external provider), five comparison lanes, at least three
repetitions, and at least two models per completed project.

## Package policy

The review archive includes source, tests, deployment manifests, examples,
architecture/reliability documentation, and only the redacted latest
Production acceptance summary. It excludes dependencies, build output,
credentials, local reports other than that summary, and sealed blind cases and
blind labels. The latter must remain evaluator-only so an external reviewing
model cannot contaminate future blind evaluation.
