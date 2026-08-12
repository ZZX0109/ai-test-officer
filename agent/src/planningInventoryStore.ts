import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import type { PlannedBusinessFlow } from "./planningConversation.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const memory = new Map<string, PlanningInventory>();
let pool: Pool | undefined;

export interface PlanningFlowPage {
  flows: PlannedBusinessFlow[];
  page: { cursor?: string; nextCursor?: string; total: number; limit: number };
}

interface PlanningInventory {
  id: string;
  projectId: string;
  snapshotHash?: string;
  flows: PlannedBusinessFlow[];
  createdAt: string;
}

function inventoryFile(id: string) {
  return path.join(rootDir, "reports", "planning-inventories", `${id}.json`);
}

function database() {
  if (!process.env.DATABASE_URL) return undefined;
  return pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
}

function encodeCursor(index: number) {
  return Buffer.from(String(index)).toString("base64url");
}

function decodeCursor(cursor?: string) {
  if (!cursor) return 0;
  const parsed = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function savePlanningInventory(input: PlanningInventory) {
  const value = { ...input, flows: [...input.flows] };
  memory.set(value.id, value);
  const db = database();
  if (db) {
    await db.query(
      `INSERT INTO planning_inventories_v1 (id, project_id, snapshot_hash, payload, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, snapshot_hash = EXCLUDED.snapshot_hash`,
      [value.id, value.projectId, value.snapshotHash ?? null, value, value.createdAt]
    );
    return;
  }
  await mkdir(path.dirname(inventoryFile(value.id)), { recursive: true });
  await writeFile(inventoryFile(value.id), JSON.stringify(value), "utf8");
}

async function loadPlanningInventory(id: string) {
  const cached = memory.get(id);
  if (cached) return cached;
  const db = database();
  if (db) {
    const result = await db.query<{ payload: PlanningInventory }>("SELECT payload FROM planning_inventories_v1 WHERE id = $1", [id]);
    const value = result.rows[0]?.payload;
    if (value) memory.set(id, value);
    return value;
  }
  const raw = await readFile(inventoryFile(id), "utf8").catch(() => undefined);
  if (!raw) return undefined;
  const value = JSON.parse(raw) as PlanningInventory;
  memory.set(id, value);
  return value;
}

export async function getPlanningFlowPage(input: { inventoryId: string; projectId: string; cursor?: string; limit?: number }): Promise<PlanningFlowPage | undefined> {
  const inventory = await loadPlanningInventory(input.inventoryId);
  if (!inventory || inventory.projectId !== input.projectId) return undefined;
  const limit = Math.max(1, Math.min(input.limit ?? 24, 100));
  const start = Math.min(decodeCursor(input.cursor), inventory.flows.length);
  const flows = inventory.flows.slice(start, start + limit);
  const nextIndex = start + flows.length;
  return {
    flows,
    page: {
      cursor: input.cursor,
      nextCursor: nextIndex < inventory.flows.length ? encodeCursor(nextIndex) : undefined,
      total: inventory.flows.length,
      limit
    }
  };
}
