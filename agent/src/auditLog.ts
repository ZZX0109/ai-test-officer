import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const auditDir = path.join(rootDir, "reports", "runs");
const auditFile = path.join(auditDir, "audit-log.jsonl");

export interface AuditEvent {
  type: "permission_check" | "agent_action" | "user_decision" | "credential_event";
  action: string;
  result: "allowed" | "denied" | "recorded";
  details: Record<string, unknown>;
}

export async function appendAudit(event: AuditEvent) {
  await mkdir(auditDir, { recursive: true });
  const line = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString()
  });
  await writeFile(auditFile, `${line}\n`, { flag: "a", mode: 0o600 });
}

export async function readAuditLog(limit = 100) {
  try {
    const raw = await readFile(auditFile, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as AuditEvent & { timestamp: string });
  } catch {
    return [];
  }
}
