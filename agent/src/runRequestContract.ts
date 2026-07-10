import { z } from "zod";

export const targetRuntimeSchema = z.object({
  projectId: z.string().optional(),
  frontendUrl: z.string().url(),
  backendUrl: z.string().url().optional(),
  healthCheckUrl: z.string().url().optional()
});

export const runnableTargetShape = {
  appUrl: z.string().url().optional(),
  projectId: z.string().optional(),
  target: targetRuntimeSchema.optional()
};

export function hasRunnableTarget(input: {
  appUrl?: string;
  projectId?: string;
  target?: unknown;
}) {
  return Boolean(input.appUrl?.trim() || input.projectId?.trim() || input.target);
}

export function requireRunnableTarget(
  input: { appUrl?: string; projectId?: string; target?: unknown },
  context: z.RefinementCtx
) {
  if (hasRunnableTarget(input)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["appUrl"],
    message: "Provide appUrl, projectId, or target."
  });
}
