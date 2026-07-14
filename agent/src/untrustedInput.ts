import type { EvidenceItem } from "./types.js";

export interface UntrustedInstructionSignal {
  source: "requirement" | "diff" | "evidence";
  evidenceId?: string;
  rule: string;
}

const patterns: Array<{ rule: string; pattern: RegExp }> = [
  { rule: "ignore_prior_instructions", pattern: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i },
  { rule: "role_override", pattern: /(?:system\s+message|you\s+are\s+now|developer\s+message)\s*[:：]/i },
  { rule: "release_override", pattern: /(?:always|must)\s+(?:approve|pass|release)\b/i },
  { rule: "credential_exfiltration", pattern: /(?:reveal|read|send|exfiltrate).{0,48}(?:api[_ -]?key|token|password|credential)/i },
  { rule: "unsafe_command", pattern: /(?:rm\s+-rf|curl\s+.+\|\s*(?:sh|bash)|delete\s+(?:all\s+)?files)/i }
];

function signalsFor(value: string, source: UntrustedInstructionSignal["source"], evidenceId?: string) {
  const bounded = value.slice(0, 80_000);
  return patterns.filter((item) => item.pattern.test(bounded)).map((item) => ({ source, evidenceId, rule: item.rule }));
}

export function detectUntrustedInstructions(input: { requirement?: string; diff?: string; evidence?: EvidenceItem[] }) {
  return [
    ...signalsFor(input.requirement ?? "", "requirement"),
    ...signalsFor(input.diff ?? "", "diff"),
    ...(input.evidence ?? []).flatMap((item) => signalsFor(`${item.title}\n${JSON.stringify(item.payload)}`, "evidence", item.id))
  ];
}
