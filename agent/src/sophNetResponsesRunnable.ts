import {
  createStructuredModelRunnable,
  type StructuredModelRequest
} from "@ai-test-officer/agent-orchestration";
import { decrypt, getCredential } from "./credentialStore.js";
import { executeLlmCall } from "./llmProvider.js";

/**
 * LangChain-facing adapter over the battle-tested OpenAI-compatible Responses
 * transport. API keys stay inside the Agent credential boundary; LangChain
 * receives typed request/response objects and sanitized telemetry only.
 */
export function createSophNetResponsesRunnable(credentialId: string) {
  return createStructuredModelRunnable(async <T>(request: StructuredModelRequest<T>) => {
    const credential = await getCredential(credentialId);
    if (!credential) throw new Error("model_credential_not_found");
    const response = await executeLlmCall({
      credential,
      apiKey: await decrypt(credential.apiKeyEncrypted),
      system: request.system,
      prompt: request.prompt,
      maxTokens: request.maxTokens,
      timeoutMs: request.timeoutMs,
      totalTimeoutMs: Math.max(request.timeoutMs, Math.min(90_000, request.timeoutMs * 2)),
      transportPreference: "auto",
      jsonSchema: request.jsonSchema,
      context: { purpose: request.purpose, runId: request.runId }
    });
    const value = request.schema.parse(JSON.parse(response.text));
    return {
      value,
      callId: response.call.id,
      model: response.call.model,
      tokenUsage: response.call.usage.totalTokens
    };
  });
}
