import type { RunProjection } from "./runEventStore.js";
import { getDatabasePool } from "./databaseRuntime.js";

interface CommittedRunEventFaultRule {
  eventType: string;
  requirement: string;
  runKind?: RunProjection["runKind"];
}

let faultCheckpointSchemaReady: Promise<void> | undefined;

async function ensureFaultCheckpointSchema() {
  const database = getDatabasePool();
  if (!database) return undefined;
  faultCheckpointSchemaReady ??= database.query(`
    CREATE TABLE IF NOT EXISTS fault_injection_checkpoints_v1 (
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, event_type)
    )
  `).then(() => undefined);
  await faultCheckpointSchemaReady;
  return database;
}

/**
 * A hard-killed Worker starts in a new process, so an in-memory guard would
 * inject the same boundary forever. Claim it in the disposable stack's
 * database instead. This table is reached only after the two explicit fault
 * guards match, and has no role in Run state or evidence decisions.
 */
async function claimFaultCheckpoint(input: { runId: string; eventType: string }) {
  const database = await ensureFaultCheckpointSchema();
  if (!database) return true;
  const result = await database.query(
    `INSERT INTO fault_injection_checkpoints_v1 (run_id,event_type)
     VALUES ($1,$2)
     ON CONFLICT (run_id,event_type) DO NOTHING
     RETURNING run_id`,
    [input.runId, input.eventType]
  );
  return result.rowCount === 1;
}

/**
 * A single environment variable keeps Compose interpolation safe while
 * allowing a disposable acceptance stack to exercise more than one exact
 * crash boundary. Invalid rules fail closed: fault injection is a test aid,
 * never a reason to pause an unrelated production Run.
 */
function configuredRules(environment: NodeJS.ProcessEnv): CommittedRunEventFaultRule[] {
  const encoded = environment.FAULT_INJECTION_RULES_B64;
  if (encoded) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((rule): CommittedRunEventFaultRule[] => {
        if (!rule || typeof rule !== "object") return [];
        const candidate = rule as Record<string, unknown>;
        if (typeof candidate.eventType !== "string" || candidate.eventType.length === 0) return [];
        if (typeof candidate.requirement !== "string" || candidate.requirement.length === 0) return [];
        if (candidate.runKind !== undefined && candidate.runKind !== "parent" && candidate.runKind !== "path") return [];
        return [{
          eventType: candidate.eventType,
          requirement: candidate.requirement,
          ...(candidate.runKind ? { runKind: candidate.runKind } : {})
        }];
      });
    } catch {
      return [];
    }
  }
  // Compatibility for an existing isolated acceptance deployment. New
  // deployments should use FAULT_INJECTION_RULES_B64 so event/rule pairs are
  // not accidentally combined as a cross product.
  const requirement = environment.FAULT_INJECTION_MATCH_REQUIREMENT;
  const eventType = environment.FAULT_INJECTION_AFTER_RUN_EVENT;
  const runKind = environment.FAULT_INJECTION_MATCH_RUN_KIND;
  if (typeof requirement !== "string" || requirement.length === 0 || typeof eventType !== "string" || eventType.length === 0) return [];
  if (runKind !== undefined && runKind !== "parent" && runKind !== "path") return [];
  return [{ eventType, requirement, ...(runKind ? { runKind } : {}) }];
}

/**
 * Test-only process checkpoint used by the disposable Production Compose
 * acceptance stack. It is deliberately opt-in twice: an operator must enable
 * fault injection in the process environment and the target Run must carry
 * the exact checkpoint tag. A user supplied Run can therefore never pause a
 * production worker on its own.
 */
export function shouldPauseAfterCommittedRunEvent(input: {
  run: RunProjection;
  eventType: string;
}, environment: NodeJS.ProcessEnv = process.env) {
  return environment.FAULT_INJECTION_ENABLED === "1"
    && configuredRules(environment).some((rule) => rule.eventType === input.eventType
      && input.run.input.requirement === rule.requirement
      && (!rule.runKind || input.run.runKind === rule.runKind));
}

/**
 * Stop immediately after the Event Store transaction commits and before the
 * caller can advance its LangGraph checkpoint. The acceptance runner observes
 * the durable event through the API, SIGKILLs the process, then verifies that
 * recovery never recreates a Gate or an external execution side effect.
 *
 * This promise intentionally has no timer: a timeout would turn a process
 * crash test into a timing race. It is unreachable unless the two opt-in
 * guards in `shouldPauseAfterCommittedRunEvent` are both true.
 */
export async function pauseAfterCommittedRunEvent(input: {
  run: RunProjection;
  eventType: string;
}) {
  if (!shouldPauseAfterCommittedRunEvent(input)) return;
  if (!await claimFaultCheckpoint({ runId: input.run.id, eventType: input.eventType })) return;
  // Keep this diagnostic free of Run input, credentials and Evidence. The
  // acceptance script only needs a stable process-side marker for debugging.
  console.error(`[fault-injection] committed_run_event:${input.eventType}:${input.run.id}`);
  await new Promise<void>(() => undefined);
}
