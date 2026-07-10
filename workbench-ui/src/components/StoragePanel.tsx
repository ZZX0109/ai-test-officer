import type { StorageArchive, StorageStatus } from "../types";

interface StoragePanelProps {
  storage?: StorageStatus | null;
  archives: StorageArchive[];
  onDryRunRetention?: () => void;
}

function formatBytes(bytes: number | undefined) {
  if (!bytes) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function StoragePanel({ storage, archives, onDryRunRetention }: StoragePanelProps) {
  return (
    <section className="storage-box">
      <h3>Storage Governance</h3>
      {storage ? (
        <>
          <div className="readiness-grid">
            <article className={storage.overBudget ? "failed" : "passed"}>
              <strong>Active Reports</strong>
              <span>{formatBytes(storage.reportsBytes)} / {storage.maxReportsMb} MB</span>
            </article>
            <article className="passed">
              <strong>Archives</strong>
              <span>{formatBytes(storage.archiveBytes)} · {storage.archiveCount ?? archives.length} batches</span>
            </article>
            <article className={storage.activeLocks.length ? "warning" : "passed"}>
              <strong>Run Locks</strong>
              <span>{storage.activeLocks.length ? storage.activeLocks.map((lock) => lock.projectId).join(", ") : "none"}</span>
            </article>
          </div>
          {storage.budget && (
            <p>
              budget=<code>{storage.budget.status}</code> · remaining={formatBytes(storage.budget.remainingBytes)}
            </p>
          )}
          {storage.lastRetentionResult && (
            <p>
              last retention actionCount=<code>{String(storage.lastRetentionResult.actionCount ?? "n/a")}</code>
            </p>
          )}
          <p><code>{storage.archiveRoot}</code></p>
          {onDryRunRetention && (
            <button type="button" onClick={onDryRunRetention}>
              Retention dry-run
            </button>
          )}
          {archives.slice(0, 3).map((archive) => (
            <article key={archive.id}>
              <strong>{archive.id}</strong>
              <p>{formatBytes(archive.sizeBytes)} · {new Date(archive.modifiedAt).toLocaleString()}</p>
            </article>
          ))}
        </>
      ) : (
        <p className="empty">Storage status unavailable.</p>
      )}
    </section>
  );
}
