const ACTIVE_RUN_CACHE_KEY = "ai-test-officer.active-runs.v2";
const ACTIVE_RUN_MAX_AGE_MS = 2 * 60 * 60 * 1_000;

interface ActiveRunCacheEntry {
  runId: string;
  rememberedAt: string;
}

export interface RestorableRunProjection {
  id: string;
  state: string;
  updatedAt?: string;
  input?: Record<string, unknown>;
}

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function readCache(): Record<string, ActiveRunCacheEntry> {
  try {
    const raw = storage()?.getItem(ACTIVE_RUN_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([projectId, value]) => {
      if (!projectId || !value || typeof value !== "object" || Array.isArray(value)) return [];
      const candidate = value as Partial<ActiveRunCacheEntry>;
      if (typeof candidate.runId !== "string" || !candidate.runId.startsWith("run_")) return [];
      if (typeof candidate.rememberedAt !== "string" || !Number.isFinite(Date.parse(candidate.rememberedAt))) return [];
      return [[projectId, { runId: candidate.runId, rememberedAt: candidate.rememberedAt }]];
    }));
  } catch {
    return {};
  }
}

export function readProjectActiveRun(projectId: string): string | undefined {
  if (!projectId) return undefined;
  const entry = readCache()[projectId];
  if (!entry) return undefined;
  if (Date.now() - Date.parse(entry.rememberedAt) > ACTIVE_RUN_MAX_AGE_MS) {
    forgetProjectActiveRun(projectId, entry.runId);
    return undefined;
  }
  return entry.runId;
}

export function rememberProjectActiveRun(projectId: string, runId: string): void {
  if (!projectId || !runId.startsWith("run_")) return;
  try {
    storage()?.setItem(ACTIVE_RUN_CACHE_KEY, JSON.stringify({
      ...readCache(),
      [projectId]: { runId, rememberedAt: new Date().toISOString() }
    }));
  } catch {
    // Restoring the canvas is a convenience. Storage restrictions must not
    // stop the run or affect its evidence.
  }
}

export function forgetProjectActiveRun(projectId: string, runId?: string): void {
  if (!projectId) return;
  try {
    const cache = readCache();
    if (runId && cache[projectId]?.runId !== runId) return;
    delete cache[projectId];
    storage()?.setItem(ACTIVE_RUN_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // See rememberProjectActiveRun.
  }
}

export function isRestorableProjectRun(
  projection: RestorableRunProjection,
  projectId: string,
  now = Date.now()
): boolean {
  if (!projectId || projection.input?.projectId !== projectId) return false;
  if (["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(projection.state)) return false;
  const updatedAt = projection.updatedAt ? Date.parse(projection.updatedAt) : Number.NaN;
  return Number.isFinite(updatedAt) && now - updatedAt <= ACTIVE_RUN_MAX_AGE_MS;
}

export function rankProjectRunCandidates(
  cachedRunId: string | undefined,
  _history: Array<{ runId: string; timestamp: string }>
): string[] {
  // Run history contains completed test results. It is intentionally not a
  // source of an "active" run: selecting or diagnosing a project must never
  // resurrect a historical pass/fail as the outcome of the current session.
  // Historical results are opened only through the explicit history action.
  return cachedRunId ? [cachedRunId] : [];
}
