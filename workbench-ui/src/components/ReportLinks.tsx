import { useState } from "react";
import { createRunBundleDownload, downloadArtifactBlob } from "../api";
import type {
  CommitCheckResult,
  PatrolRunResult,
  RequirementAcceptanceResult,
  RunBundleDownloadManifest,
  RunResult
} from "../types";
import { AuthenticatedArtifactLink } from "./AuthenticatedArtifact";

interface ReportLinksProps {
  result?: RunResult | null;
  commitCheck?: CommitCheckResult | null;
  requirementAcceptance?: RequirementAcceptanceResult | null;
  patrolRun?: PatrolRunResult | null;
}

export function ReportLinks({ result, commitCheck, requirementAcceptance, patrolRun }: ReportLinksProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadManifest, setDownloadManifest] = useState<RunBundleDownloadManifest | null>(null);
  const [downloadManifestFile, setDownloadManifestFile] = useState<string | null>(null);

  async function downloadRunBundle() {
    if (!result) return;
    setIsDownloading(true);
    setDownloadError(null);
    try {
      const response = await createRunBundleDownload(result.id);
      setDownloadManifest(response.archive.manifest);
      setDownloadManifestFile(response.archive.manifestFile);
      const blob = await downloadArtifactBlob(response.archive.zipFile);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${result.id}-run-bundle.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "download failed");
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <section>
      <h3>Run Bundle</h3>
      {result ? (
        <div className="bundle-box">
          <p>{result.aggregatedVerdict.reason}</p>
          <p>{result.reflectionNote}</p>
          <p>Conflict: {result.conflictPacket.status} · {result.conflictPacket.reason}</p>
          {result.htmlReportFile && (
            <AuthenticatedArtifactLink artifactUrl={result.htmlReportFile}>
              打开 HTML 报告
            </AuthenticatedArtifactLink>
          )}
          {result.markdownReportFile && (
            <AuthenticatedArtifactLink artifactUrl={result.markdownReportFile}>
              打开 Markdown 报告
            </AuthenticatedArtifactLink>
          )}
          {commitCheck?.commitCheckFile && (
            <AuthenticatedArtifactLink artifactUrl={commitCheck.commitCheckFile}>
              打开 commit_check.json
            </AuthenticatedArtifactLink>
          )}
          {requirementAcceptance?.acceptanceFile && (
            <AuthenticatedArtifactLink artifactUrl={requirementAcceptance.acceptanceFile}>
              打开 acceptance.json
            </AuthenticatedArtifactLink>
          )}
          {patrolRun?.patrolFile && (
            <AuthenticatedArtifactLink artifactUrl={patrolRun.patrolFile}>
              打开 patrol.json
            </AuthenticatedArtifactLink>
          )}
          {result.artifactIntegrityReportFile && (
            <AuthenticatedArtifactLink artifactUrl={result.artifactIntegrityReportFile}>
              打开 artifact_integrity.json
            </AuthenticatedArtifactLink>
          )}
          <AuthenticatedArtifactLink artifactUrl={result.runBundleFile}>
            打开 run_bundle.json
          </AuthenticatedArtifactLink>
          <div className="bundle-actions">
            <button type="button" onClick={downloadRunBundle} disabled={isDownloading}>
              {isDownloading ? "正在生成下载包..." : "生成并下载 run bundle"}
            </button>
            {downloadManifestFile && (
              <AuthenticatedArtifactLink artifactUrl={downloadManifestFile}>
                打开下载 manifest
              </AuthenticatedArtifactLink>
            )}
          </div>
          {downloadManifest && (
            <p className="bundle-status">
              download manifest: included=
              {downloadManifest.entries.filter((entry) => entry.status === "included").length} · referenceOnly=
              {downloadManifest.entries.filter((entry) => entry.status === "reference_only").length} · missing=
              {downloadManifest.entries.filter((entry) => entry.status === "missing").length}
            </p>
          )}
          {downloadError && <p className="bundle-error">下载失败：{downloadError}</p>}
        </div>
      ) : (
        <p className="empty">暂无 run bundle。</p>
      )}
    </section>
  );
}
