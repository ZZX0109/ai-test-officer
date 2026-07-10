import type { RunResult } from "../types";
import { AuthenticatedArtifactLink } from "./AuthenticatedArtifact";

interface ArtifactIntegrityPanelProps {
  result?: RunResult | null;
}

function statusClass(status: string) {
  if (status === "present" || status === "self_reference") return "passed";
  if (status === "missing" || status === "path_escape") return "failed";
  return "warning";
}

function formatBytes(size: number | undefined) {
  if (typeof size !== "number") return "metadata";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function ArtifactIntegrityPanel({ result }: ArtifactIntegrityPanelProps) {
  const report = result?.artifactIntegrity;
  const risky = report?.items.filter((item) => ["missing", "unreadable", "path_escape"].includes(item.status)) ?? [];
  const sampledItems = risky.length ? risky.slice(0, 6) : report?.items.slice(0, 6) ?? [];

  return (
    <section className="artifact-integrity-box">
      <h3>Artifact Integrity</h3>
      {report ? (
        <>
          <div className="integrity-grid">
            <article className={report.summary.missing || report.summary.pathEscapes ? "failed" : "passed"}>
              <strong>{report.summary.total}</strong>
              <span>tracked</span>
            </article>
            <article className="passed">
              <strong>{report.summary.hashed}</strong>
              <span>sha256</span>
            </article>
            <article className={report.summary.missing ? "failed" : "passed"}>
              <strong>{report.summary.missing}</strong>
              <span>missing</span>
            </article>
            <article className={report.summary.pathEscapes ? "failed" : "passed"}>
              <strong>{report.summary.pathEscapes}</strong>
              <span>path escape</span>
            </article>
          </div>
          <p className="integrity-note">
            generated={new Date(report.generatedAt).toLocaleString()} · selfRefs={report.summary.selfReferences}
          </p>
          {result?.artifactIntegrityReportFile && (
            <AuthenticatedArtifactLink artifactUrl={result.artifactIntegrityReportFile}>
              打开 artifact_integrity.json
            </AuthenticatedArtifactLink>
          )}
          <div className="integrity-list">
            {sampledItems.map((item) => (
              <article className={statusClass(item.status)} key={item.id}>
                <header>
                  <strong>{item.kind}</strong>
                  <span>{item.status}</span>
                </header>
                <code>{item.artifactUri}</code>
                <p>
                  {formatBytes(item.sizeBytes)}
                  {item.sha256 ? ` · sha256=${item.sha256.slice(0, 12)}...` : ""}
                  {item.evidenceId ? ` · ${item.evidenceId}` : ""}
                </p>
                {item.reason && <p>{item.reason}</p>}
              </article>
            ))}
          </div>
        </>
      ) : (
        <p className="empty">当前 run bundle 未包含 artifact integrity；旧 run 会显示为 not available。</p>
      )}
    </section>
  );
}
