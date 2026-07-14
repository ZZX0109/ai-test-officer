import { createHash } from "node:crypto";

export type GithubCheckConclusion = "success" | "failure" | "neutral" | "action_required" | "cancelled";

export function githubConclusionForGate(input: { gateStatus?: string; exitCode: number }): GithubCheckConclusion {
  if (input.gateStatus === "blocked" || input.exitCode === 3) return "action_required";
  if (input.gateStatus === "needs-human-review" || input.exitCode === 2) return "neutral";
  if (input.gateStatus === "fail" || input.exitCode === 1 || input.exitCode === 4) return "failure";
  return "success";
}

export function githubCheckIdempotencyKey(input: { commitSha: string; manifestHash: string; agentVersion: string }) {
  return createHash("sha256").update(`${input.commitSha}:${input.manifestHash}:${input.agentVersion}`).digest("hex");
}

function repositoryParts(repository: string) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error("github_repository_invalid");
  return { owner, repo };
}

export async function publishGithubCheck(input: {
  token: string;
  repository: string;
  commitSha: string;
  name?: string;
  gateStatus?: string;
  exitCode: number;
  title: string;
  summary: string;
  detailsUrl?: string;
  annotations?: Array<{ path: string; start_line: number; end_line: number; annotation_level: string; message: string; title?: string }>;
  externalId: string;
  apiBaseUrl?: string;
}) {
  const { owner, repo } = repositoryParts(input.repository);
  const response = await fetch(`${input.apiBaseUrl ?? "https://api.github.com"}/repos/${owner}/${repo}/check-runs`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({
      name: input.name ?? "AI Test Officer",
      head_sha: input.commitSha,
      status: "completed",
      conclusion: githubConclusionForGate(input),
      external_id: input.externalId,
      details_url: input.detailsUrl,
      output: {
        title: input.title,
        summary: input.summary.slice(0, 65_535),
        annotations: (input.annotations ?? []).filter((item) => item.path !== "AI_TEST_OFFICER").slice(0, 50)
      }
    })
  });
  if (!response.ok) throw new Error(`github_check_failed:${response.status}:${(await response.text()).slice(0, 500)}`);
  return response.json() as Promise<{ id: number; html_url?: string; conclusion: GithubCheckConclusion }>;
}

export function forkExecutionPolicy(input: { isFork: boolean; approved: boolean }) {
  if (!input.isFork) return { allowed: true, status: "pass" as const, reason: "same_repository" };
  if (!input.approved) return { allowed: false, status: "blocked" as const, reason: "fork_requires_maintainer_approval" };
  return { allowed: true, status: "pass" as const, reason: "maintainer_approved_immutable_sha" };
}
