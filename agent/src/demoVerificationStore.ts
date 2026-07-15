import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DemoVerificationResult } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const latestFile = path.join(rootDir, "reports", "demo-verification", "latest.json");

export async function readLatestDemoVerification() {
  try {
    const raw = await readFile(latestFile, "utf8");
    return JSON.parse(raw) as DemoVerificationResult;
  } catch {
    return undefined;
  }
}
