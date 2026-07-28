import { RunnableLambda } from "@langchain/core/runnables";
import { z } from "zod";

export interface StructuredModelRequest<T> {
  purpose: "planning" | "judging" | "triage" | "repairing" | "assistant";
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxTokens: number;
  timeoutMs: number;
  runId?: string;
}

export interface StructuredModelResponse<T> {
  value: T;
  callId?: string;
  model?: string;
  tokenUsage?: number;
}

export type StructuredModelExecutor = <T>(request: StructuredModelRequest<T>) => Promise<StructuredModelResponse<T>>;

/**
 * LangChain adapter for the existing bounded Responses implementation.
 *
 * The provider remains responsible for streaming fallbacks, telemetry and
 * credential handling. LangChain receives only typed input/output and never
 * receives the API key.
 */
export function createStructuredModelRunnable<T>(executor: StructuredModelExecutor) {
  return RunnableLambda.from(async (request: StructuredModelRequest<T>) => executor(request));
}
