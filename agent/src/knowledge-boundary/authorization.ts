import type { KnowledgeBoundaryOutput, LlmKnowledgeContext } from "@ai-test-officer/contracts";
import { assertKnowledgeCanAuthorizeAction } from "../knowledgeBoundary.js";
import { publishKnowledgeLifecycle } from "./lifecycle.js";

const automaticallyAuthorizedReadCapabilities = new Set([
  "read-run-evidence",
  "read-project-manifest",
  "inspect-project-file",
  "inspect-route",
  "inspect-api-operation",
  "read-repair-history",
  "read-runtime-log"
]);

export function authorizeKnowledgeAction(input: {
  context: LlmKnowledgeContext;
  output: KnowledgeBoundaryOutput;
  capability: string;
  critical?: boolean;
  grantedCapabilities?: string[];
}) {
  try {
    assertKnowledgeCanAuthorizeAction({
      context: input.context,
      output: input.output,
      action: input.capability,
      critical: input.critical ?? true
    });
    const proposed = input.output.proposedActions.find((item) => item.capability === input.capability);
    if (!proposed) throw new Error(`knowledge_action_not_proposed:${input.capability}`);
    if (
      !automaticallyAuthorizedReadCapabilities.has(input.capability)
      && !input.grantedCapabilities?.includes(input.capability)
    ) {
      throw new Error(`knowledge_action_requires_interrupt:${input.capability}`);
    }
    publishKnowledgeLifecycle({
      runId: input.context.runId,
      type: "knowledge.action.authorized",
      payload: { contextId: input.context.id, capability: input.capability }
    });
    return proposed;
  } catch (error) {
    publishKnowledgeLifecycle({
      runId: input.context.runId,
      type: "knowledge.action.denied",
      payload: {
        contextId: input.context.id,
        capability: input.capability,
        errorCode: error instanceof Error ? error.message : "knowledge_action_denied"
      }
    });
    throw error;
  }
}
