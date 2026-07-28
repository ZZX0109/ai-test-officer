import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { agentGraphProjectionSchema, type AgentGraphProjection } from "@ai-test-officer/contracts";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const file = path.join(rootDir, "reports", "agent-graph", "projections.json");
let postgresPool: Pool | undefined;

function pool() {
  if (!process.env.DATABASE_URL) return undefined;
  postgresPool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return postgresPool;
}

async function readLocal(): Promise<Record<string, AgentGraphProjection>> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).flatMap(([runId, item]) => {
      const parsed = agentGraphProjectionSchema.safeParse(item);
      return parsed.success ? [[runId, parsed.data]] : [];
    }));
  } catch {
    return {};
  }
}

export async function saveAgentGraphProjection(input: AgentGraphProjection) {
  const projection = agentGraphProjectionSchema.parse(input);
  const database = pool();
  if (database) {
    await database.query(
      `INSERT INTO agent_graph_projections_v1 (run_id, projection, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (run_id) DO UPDATE SET projection = EXCLUDED.projection, updated_at = EXCLUDED.updated_at`,
      [projection.runId, JSON.stringify(projection), projection.updatedAt]
    );
    return projection;
  }
  const current = await readLocal();
  current[projection.runId] = projection;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(current, null, 2));
  return projection;
}

export async function readAgentGraphProjection(runId: string) {
  const database = pool();
  if (database) {
    const result = await database.query<{ projection: unknown }>(
      "SELECT projection FROM agent_graph_projections_v1 WHERE run_id = $1",
      [runId]
    );
    const parsed = agentGraphProjectionSchema.safeParse(result.rows[0]?.projection);
    return parsed.success ? parsed.data : undefined;
  }
  return (await readLocal())[runId];
}
