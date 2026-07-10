import type { RunResult } from "../types";

interface JudgePanelProps {
  result?: RunResult | null;
}

function changeRefLabel(ref: NonNullable<RunResult["failureAttributions"][number]["changeRefs"]>[number]) {
  const lineRange = ref.lineStart
    ? `:${ref.lineStart}${ref.lineEnd && ref.lineEnd !== ref.lineStart ? `-${ref.lineEnd}` : ""}`
    : "";
  const signals = ref.matchedSignals?.length ? ` signals=${ref.matchedSignals.join(",")}` : "";
  const diagnosticSignals = ref.diagnosticSignals?.length
    ? ` diagnostic=${ref.diagnosticSignals.map((signal) => `${signal.kind}:${signal.value}`).join(",")}`
    : "";
  return `${ref.file}${lineRange}${ref.hunk ? ` ${ref.hunk}` : ""}${signals}${diagnosticSignals}`;
}

export function JudgePanel({ result }: JudgePanelProps) {
  return (
    <section>
      <h3>LLM-as-Judge</h3>
      {result?.judgeReport ? (
        <div className="judge-list">
          <article className="judge-source">
            <strong>{result.judgeReport.source}</strong>
            <p>
              {result.judgeReport.executionMode === "llm_assisted"
                ? "已使用 Credential Center 中的模型进行三层复核。"
                : result.judgeReport.executionMode === "fallback_baseline"
                  ? "模型调用或结构化校验失败，当前使用确定性基线并保留失败原因。"
                  : "未配置可用模型，当前使用确定性 Judge。"}
            </p>
            <code>
              mode={result.judgeReport.executionMode} · llm={result.judgeReport.llmStatus} · policy=
              {result.judgeReport.policyVersion}
            </code>
            {result.judgeReport.llmError && <p>Error: {result.judgeReport.llmError}</p>}
          </article>
          {[
            result.judgeReport.planJudge,
            result.judgeReport.evidenceJudge,
            result.judgeReport.releaseJudge
          ].map((judge) => (
            <article className={`judge ${judge.verdict}`} key={judge.layer}>
              <header>
                <strong>{judge.title}</strong>
                <span>{judge.verdict}</span>
              </header>
              <p>{judge.summary}</p>
              {judge.findings.map((finding) => (
                      <div className="finding" key={finding.id}>
                        <strong>{finding.title}</strong>
                        {finding.failureClass && <code>{finding.failureClass}</code>}
                        <p>{finding.reasoning}</p>
                  <code>{finding.evidenceRefs.length ? finding.evidenceRefs.join(", ") : "no evidence ref"}</code>
                </div>
              ))}
            </article>
          ))}
        </div>
      ) : (
        <p className="empty">执行后会显示 Plan Judge、Evidence Judge、Release Judge。</p>
      )}
      {result?.failureAttributions?.length ? (
        <div className="judge-list">
          <article className="judge-source">
            <strong>Failure Attribution</strong>
            <p>按证据、影响面和 diff hunk 排序的可能原因。</p>
          </article>
          {result.failureAttributions.map((item) => (
            <article className="finding" key={item.id}>
              <strong>#{item.rank} {item.title}</strong>
              <code>{item.failureClass} · {item.confidence}</code>
              <p>{item.reasoning}</p>
              {item.changeRefs?.length ? (
                <code>{item.changeRefs.map(changeRefLabel).join(" | ")}</code>
              ) : (
                <code>no change refs</code>
              )}
              {item.topSuspects?.length ? (
                <ul>
                  {item.topSuspects.map((suspect) => (
                    <li key={`${item.id}-${suspect.filePath}-${suspect.lineStart ?? "file"}`}>
                      <strong>{suspect.filePath}{suspect.lineStart ? `:${suspect.lineStart}` : ""}</strong>
                      {(suspect.componentName || suspect.apiEndpoint) && (
                        <code>
                          {suspect.componentName ? `component=${suspect.componentName}` : ""}
                          {suspect.componentName && suspect.apiEndpoint ? " · " : ""}
                          {suspect.apiEndpoint ? `api=${suspect.apiEndpoint}` : ""}
                        </code>
                      )}
                      <p>{suspect.reason}</p>
                      <code>{suspect.confidence} · evidence={suspect.evidenceRefs.join(", ") || "none"}</code>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
