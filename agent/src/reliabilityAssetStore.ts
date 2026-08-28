import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DifferentialRunV1,
  OracleSpecV2,
  TestAssetV1,
  TestDataContractV1,
  TestDataPhaseReceiptV1,
  ReliabilityAssetOutboxPayloadV1
} from "@ai-test-officer/contracts";
import {
  differentialRunV1Schema,
  oracleSpecV2Schema,
  testAssetV1Schema,
  testDataContractV1Schema,
  testDataPhaseReceiptV1Schema
} from "@ai-test-officer/contracts";
import { getDatabasePool } from "./databaseRuntime.js";
import { insertOutboxInTransaction } from "./outboxStore.js";
import type { EvidenceItem } from "./types.js";

export interface ReliabilityAssetState {
  oracles: OracleSpecV2[];
  dataContracts: TestDataContractV1[];
  dataReceipts: TestDataPhaseReceiptV1[];
  differentialRuns: DifferentialRunV1[];
  testAssets: TestAssetV1[];
  reliabilityEvidence: EvidenceItem[];
  reliabilityOutbox: ReliabilityAssetOutboxPayloadV1[];
}

export interface ReliabilityAssetMutation {
  kind: "oracle" | "data-contract" | "data-receipt" | "differential-run" | "test-asset";
  entityId: string;
  value: unknown;
  event: ReliabilityAssetOutboxPayloadV1;
  evidence?: EvidenceItem;
}

export interface ReliabilityAssetStore {
  getOracle(id: string): Promise<OracleSpecV2 | undefined>;
  listOracles(projectId: string): Promise<OracleSpecV2[]>;
  putOracle(value: OracleSpecV2): Promise<void>;
  getDataContract(id: string): Promise<TestDataContractV1 | undefined>;
  listDataContracts(projectId: string): Promise<TestDataContractV1[]>;
  putDataContract(value: TestDataContractV1): Promise<void>;
  appendDataReceipts(values: TestDataPhaseReceiptV1[]): Promise<void>;
  getDifferentialRun(id: string): Promise<DifferentialRunV1 | undefined>;
  findDifferentialByIdempotencyKey(key: string): Promise<DifferentialRunV1 | undefined>;
  putDifferentialRun(value: DifferentialRunV1): Promise<void>;
  getTestAsset(id: string): Promise<TestAssetV1 | undefined>;
  putTestAsset(value: TestAssetV1): Promise<void>;
  mutate(input: ReliabilityAssetMutation): Promise<void>;
  readReliabilityEvidence(runId: string): Promise<EvidenceItem[]>;
}

function emptyState(): ReliabilityAssetState {
  return { oracles: [], dataContracts: [], dataReceipts: [], differentialRuns: [], testAssets: [], reliabilityEvidence: [], reliabilityOutbox: [] };
}

export class FileReliabilityAssetStore implements ReliabilityAssetStore {
  private loadPromise: Promise<void> | undefined;
  private state = emptyState();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async ensureLoaded() {
    this.loadPromise ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<ReliabilityAssetState>;
        this.state = {
          oracles: parsed.oracles ?? [],
          dataContracts: parsed.dataContracts ?? [],
          dataReceipts: parsed.dataReceipts ?? [],
          differentialRuns: parsed.differentialRuns ?? [],
          testAssets: parsed.testAssets ?? [],
          reliabilityEvidence: parsed.reliabilityEvidence ?? [],
          reliabilityOutbox: parsed.reliabilityOutbox ?? []
        };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    })();
    await this.loadPromise;
  }

  private async flush() {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.writeChain;
  }

  async getOracle(id: string) { await this.ensureLoaded(); return this.state.oracles.find((item) => item.id === id); }
  async listOracles(projectId: string) { await this.ensureLoaded(); return this.state.oracles.filter((item) => item.projectId === projectId); }
  async putOracle(value: OracleSpecV2) {
    await this.ensureLoaded();
    this.state.oracles = [...this.state.oracles.filter((item) => item.id !== value.id), value];
    await this.flush();
  }

  async getDataContract(id: string) { await this.ensureLoaded(); return this.state.dataContracts.find((item) => item.id === id); }
  async listDataContracts(projectId: string) { await this.ensureLoaded(); return this.state.dataContracts.filter((item) => item.projectId === projectId); }
  async putDataContract(value: TestDataContractV1) {
    await this.ensureLoaded();
    this.state.dataContracts = [...this.state.dataContracts.filter((item) => item.id !== value.id), value];
    await this.flush();
  }

  async appendDataReceipts(values: TestDataPhaseReceiptV1[]) {
    await this.ensureLoaded();
    const ids = new Set(values.map((item) => item.id));
    this.state.dataReceipts = [
      ...this.state.dataReceipts.filter((item) => !ids.has(item.id)),
      ...values
    ];
    await this.flush();
  }

  async getDifferentialRun(id: string) { await this.ensureLoaded(); return this.state.differentialRuns.find((item) => item.id === id); }
  async findDifferentialByIdempotencyKey(key: string) {
    await this.ensureLoaded();
    return this.state.differentialRuns.find((item) => item.idempotencyKey === key);
  }
  async putDifferentialRun(value: DifferentialRunV1) {
    await this.ensureLoaded();
    this.state.differentialRuns = [...this.state.differentialRuns.filter((item) => item.id !== value.id), value];
    await this.flush();
  }

  async getTestAsset(id: string) { await this.ensureLoaded(); return this.state.testAssets.find((item) => item.id === id); }
  async putTestAsset(value: TestAssetV1) {
    await this.ensureLoaded();
    this.state.testAssets = [...this.state.testAssets.filter((item) => item.id !== value.id), value];
    await this.flush();
  }

  async mutate(input: ReliabilityAssetMutation) {
    await this.ensureLoaded();
    if (input.kind === "oracle") this.state.oracles = [...this.state.oracles.filter((item) => item.id !== input.entityId), oracleSpecV2Schema.parse(input.value)];
    if (input.kind === "data-contract") this.state.dataContracts = [...this.state.dataContracts.filter((item) => item.id !== input.entityId), testDataContractV1Schema.parse(input.value)];
    if (input.kind === "data-receipt") this.state.dataReceipts = [...this.state.dataReceipts.filter((item) => item.id !== input.entityId), testDataPhaseReceiptV1Schema.parse(input.value)];
    if (input.kind === "differential-run") this.state.differentialRuns = [...this.state.differentialRuns.filter((item) => item.id !== input.entityId), differentialRunV1Schema.parse(input.value)];
    if (input.kind === "test-asset") this.state.testAssets = [...this.state.testAssets.filter((item) => item.id !== input.entityId), testAssetV1Schema.parse(input.value)];
    if (input.evidence) this.state.reliabilityEvidence = [...this.state.reliabilityEvidence.filter((item) => item.id !== input.evidence!.id), input.evidence];
    this.state.reliabilityOutbox = [
      ...this.state.reliabilityOutbox.filter((item) => item.eventId !== input.event.eventId),
      input.event
    ];
    await this.flush();
  }

  async readReliabilityEvidence(runId: string) {
    await this.ensureLoaded();
    return this.state.reliabilityEvidence.filter((item) => item.runId === runId);
  }
}

/** PostgreSQL projection used whenever the application already has a durable
 * database. The file implementation remains a local-development fallback;
 * production state therefore does not fork into a second filesystem source. */
export class PostgresReliabilityAssetStore implements ReliabilityAssetStore {
  private initialized: Promise<void> | undefined;
  constructor(private readonly database = getDatabasePool()) {}

  private async init() {
    if (!this.database) throw new Error("DATABASE_URL is required for durable reliability assets");
    this.initialized ??= this.database.query(`
      CREATE TABLE IF NOT EXISTS reliability_assets_v1 (
        kind TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (kind, asset_id)
      );
      CREATE INDEX IF NOT EXISTS reliability_assets_v1_kind_idx
        ON reliability_assets_v1 (kind, updated_at);
      CREATE TABLE IF NOT EXISTS reliability_asset_evidence_v1 (
        evidence_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS reliability_asset_evidence_v1_run_idx
        ON reliability_asset_evidence_v1 (run_id, created_at, evidence_id);
    `).then(() => undefined);
    await this.initialized;
  }

  private async get<T>(kind: string, id: string, parse: (value: unknown) => T) {
    await this.init();
    const result = await this.database!.query<{ payload: unknown }>(
      "SELECT payload FROM reliability_assets_v1 WHERE kind=$1 AND asset_id=$2",
      [kind, id]
    );
    return result.rows[0] ? parse(result.rows[0].payload) : undefined;
  }

  private async put(kind: string, id: string, payload: unknown) {
    await this.init();
    await this.database!.query(
      `INSERT INTO reliability_assets_v1 (kind,asset_id,payload)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (kind,asset_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`,
      [kind, id, JSON.stringify(payload)]
    );
  }

  async getOracle(id: string) { return this.get("oracle", id, (value) => oracleSpecV2Schema.parse(value)); }
  async listOracles(projectId: string) {
    await this.init();
    const result = await this.database!.query<{ payload: unknown }>(
      "SELECT payload FROM reliability_assets_v1 WHERE kind='oracle' AND payload->>'projectId'=$1 ORDER BY updated_at,id",
      [projectId]
    );
    return result.rows.map((row) => oracleSpecV2Schema.parse(row.payload));
  }
  async putOracle(value: OracleSpecV2) { await this.put("oracle", value.id, value); }
  async getDataContract(id: string) { return this.get("data-contract", id, (value) => testDataContractV1Schema.parse(value)); }
  async listDataContracts(projectId: string) {
    await this.init();
    const result = await this.database!.query<{ payload: unknown }>(
      "SELECT payload FROM reliability_assets_v1 WHERE kind='data-contract' AND payload->>'projectId'=$1 ORDER BY updated_at,id",
      [projectId]
    );
    return result.rows.map((row) => testDataContractV1Schema.parse(row.payload));
  }
  async putDataContract(value: TestDataContractV1) { await this.put("data-contract", value.id, value); }
  async appendDataReceipts(values: TestDataPhaseReceiptV1[]) {
    for (const value of values) await this.put("data-receipt", value.id, value);
  }
  async getDifferentialRun(id: string) { return this.get("differential-run", id, (value) => differentialRunV1Schema.parse(value)); }
  async findDifferentialByIdempotencyKey(key: string) {
    await this.init();
    const result = await this.database!.query<{ payload: unknown }>(
      "SELECT payload FROM reliability_assets_v1 WHERE kind='differential-run' AND payload->>'idempotencyKey'=$1 LIMIT 1",
      [key]
    );
    return result.rows[0] ? differentialRunV1Schema.parse(result.rows[0].payload) : undefined;
  }
  async putDifferentialRun(value: DifferentialRunV1) { await this.put("differential-run", value.id, value); }
  async getTestAsset(id: string) { return this.get("test-asset", id, (value) => testAssetV1Schema.parse(value)); }
  async putTestAsset(value: TestAssetV1) { await this.put("test-asset", value.id, value); }

  async mutate(input: ReliabilityAssetMutation) {
    await this.init();
    const client = await this.database!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO reliability_assets_v1 (kind,asset_id,payload)
         VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (kind,asset_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`,
        [input.kind, input.entityId, JSON.stringify(input.value)]
      );
      if (input.evidence) {
        await client.query(
          `INSERT INTO reliability_asset_evidence_v1 (evidence_id,run_id,payload)
           VALUES ($1,$2,$3::jsonb)
           ON CONFLICT (evidence_id) DO NOTHING`,
          [input.evidence.id, input.evidence.runId, JSON.stringify(input.evidence)]
        );
      }
      await insertOutboxInTransaction(client, {
        topic: "reliability.asset",
        aggregateId: input.entityId,
        idempotencyKey: `reliability:${input.event.eventId}`,
        payload: input.event
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readReliabilityEvidence(runId: string) {
    await this.init();
    const result = await this.database!.query<{ payload: unknown }>(
      "SELECT payload FROM reliability_asset_evidence_v1 WHERE run_id=$1 ORDER BY created_at,evidence_id",
      [runId]
    );
    return result.rows.map((row) => row.payload as EvidenceItem);
  }
}

let store: ReliabilityAssetStore | undefined;

export function getReliabilityAssetStore(file?: string) {
  if (file) store = new FileReliabilityAssetStore(file);
  if (!store && process.env.DATABASE_URL) {
    store = new PostgresReliabilityAssetStore();
  }
  if (!store) {
    const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
    store = new FileReliabilityAssetStore(path.join(rootDir, "reports", "reliability-assets", "state.json"));
  }
  return store;
}

export async function recordReliabilityMutation(input: {
  store: ReliabilityAssetStore;
  kind: ReliabilityAssetMutation["kind"];
  entityId: string;
  value: unknown;
  operation: ReliabilityAssetOutboxPayloadV1["operation"];
  projectId: string;
  sourceRunId?: string;
  evidenceTitle: string;
  evidencePayload: Record<string, unknown>;
  evidenceRefs?: string[];
  assetVersion?: number;
}) {
  const occurredAt = new Date().toISOString();
  const assetVersion = input.assetVersion ?? 1;
  const mutationKey = createHash("sha256").update(JSON.stringify({
    kind: input.kind,
    entityId: input.entityId,
    operation: input.operation,
    value: input.value,
    evidenceRefs: input.evidenceRefs ?? []
  })).digest("hex").slice(0, 32);
  const evidence: EvidenceItem = {
    id: `reliability_${mutationKey}`,
    runId: input.sourceRunId ?? input.entityId,
    type: "operation",
    title: input.evidenceTitle,
    timestamp: occurredAt,
    payload: input.evidencePayload
  };
  const event: ReliabilityAssetOutboxPayloadV1 = {
    schemaVersion: "1.0",
    eventId: `reliability_event_${mutationKey}`,
    entityKind: input.kind,
    entityId: input.entityId,
    operation: input.operation,
    projectId: input.projectId,
    sourceRunId: input.sourceRunId,
    assetVersion,
    evidenceRefs: [...new Set([...(input.evidenceRefs ?? []), evidence.id])],
    occurredAt
  };
  await input.store.mutate({ kind: input.kind, entityId: input.entityId, value: input.value, event, evidence });
  return evidence;
}
