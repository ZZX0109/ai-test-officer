import type { SourceReadEnvelope } from "../types";

export function SourceStatusPanel({ sources }: { sources?: SourceReadEnvelope[] }) {
  if (!sources?.length) return null;
  return (
    <section className="source-status-box">
      <h3>Source Contexts</h3>
      <div className="source-list">
        {sources.map((source) => (
          <article key={source.id} className={source.status === "connected" ? "passed" : source.status === "missing" ? "failed" : "warning"}>
            <strong>{source.title}</strong>
            <span>{source.kind} · {source.displayStatus ?? source.status} · trust={source.trustLevel}</span>
            <p>{source.plainLanguageSummary ?? source.summary}</p>
            <p>
              permission={source.permissionState} · use={source.evidenceUse ?? "planning"} ·
              simulated={source.isSimulated ? "yes" : "no"}
            </p>
            {source.uri && <code>{source.uri}</code>}
            {source.contentHash && <code>sha={source.contentHash}</code>}
            {source.readMeta && (
              <p>
                read={source.readMeta.cacheStatus ?? "n/a"} · attempts={source.readMeta.attempts ?? "n/a"}
                {source.readMeta.httpStatus ? ` · http=${source.readMeta.httpStatus}` : ""}
                {source.readMeta.rateLimit?.remaining !== undefined ? ` · rateRemaining=${source.readMeta.rateLimit.remaining}` : ""}
                {source.readMeta.pagination ? ` · pages=${source.readMeta.pagination.pagesRead} · items=${source.readMeta.pagination.itemCount ?? "n/a"}${source.readMeta.pagination.hasMore ? "+" : ""}` : ""}
              </p>
            )}
            {source.readMeta?.openApi && (
              <>
                <p>
                  openapi={source.readMeta.openApi.version ?? source.readMeta.documentVersion ?? "unknown"} · operations={source.readMeta.openApi.operationCount}
                </p>
                <div className="chip-list">
                  {source.readMeta.openApi.operations.slice(0, 8).map((operation) => (
                    <span key={`${source.id}-${operation.method}-${operation.path}`}>
                      {operation.method} {operation.path}
                    </span>
                  ))}
                </div>
              </>
            )}
            {source.failureReason && <p>failure: {source.failureReason}</p>}
          </article>
        ))}
      </div>
    </section>
  );
}
