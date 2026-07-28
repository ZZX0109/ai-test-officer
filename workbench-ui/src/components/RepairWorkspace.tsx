import { DiffEditor } from "@monaco-editor/react";
import { useEffect, useMemo, useState } from "react";
import { downloadArtifactBlob } from "../api";
import type { RepairFileContent, RepairSession } from "../types";

interface RepairWorkspaceProps {
  session: RepairSession;
  canApply?: boolean;
  onLoadFile: (path: string) => Promise<RepairFileContent>;
  onSaveFile: (file: RepairFileContent, content: string) => Promise<RepairSession>;
  onValidate: () => Promise<RepairSession>;
  onExport: (format: "patch" | "zip") => Promise<{ downloadUrl: string }>;
  onApply: (confirmHighRisk: boolean) => Promise<RepairSession>;
  onClose: () => void;
}

function languageFor(filePath: string) {
  if (/\.tsx?$/.test(filePath)) return "typescript";
  if (/\.jsx?$/.test(filePath)) return "javascript";
  if (/\.py$/.test(filePath)) return "python";
  if (/\.json$/.test(filePath)) return "json";
  if (/\.ya?ml$/.test(filePath)) return "yaml";
  if (/\.css$/.test(filePath)) return "css";
  if (/\.html?$/.test(filePath)) return "html";
  if (/\.md$/.test(filePath)) return "markdown";
  return "plaintext";
}

const riskLabel = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  forbidden: "禁止修改"
} as const;

export function RepairWorkspace({
  session,
  canApply = false,
  onLoadFile,
  onSaveFile,
  onValidate,
  onExport,
  onApply,
  onClose
}: RepairWorkspaceProps) {
  const [activePath, setActivePath] = useState(session.files[0]?.path);
  const [file, setFile] = useState<RepairFileContent>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState("");
  const activeChange = useMemo(
    () => session.files.find((item) => item.path === activePath),
    [activePath, session.files]
  );

  useEffect(() => {
    if (!activePath) {
      setFile(undefined);
      setDraft("");
      return;
    }
    let live = true;
    setBusy("正在读取沙盒文件");
    void onLoadFile(activePath)
      .then((next) => {
        if (!live) return;
        setFile(next);
        setDraft(next.content);
        setMessage("");
      })
      .catch((error) => live && setMessage(error instanceof Error ? error.message : "读取文件失败"))
      .finally(() => live && setBusy(undefined));
    return () => { live = false; };
  }, [activePath, onLoadFile]);

  async function act(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${label}失败`);
    } finally {
      setBusy(undefined);
    }
  }

  async function downloadArtifact(downloadUrl: string, filename: string) {
    const blob = await downloadArtifactBlob(downloadUrl);
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }

  return (
    <section className="repair-workspace" aria-label="修复工作区">
      <header className="repair-workspace-header">
        <div>
          <span className="eyebrow">沙盒代码修复</span>
          <h2>修复工作区</h2>
          <p>{session.summary}</p>
        </div>
        <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
      </header>

      <div className="repair-workspace-grid">
        <aside className="repair-file-tree">
          <strong>变更文件</strong>
          <span>{session.files.length}/{session.maxFiles} 个文件</span>
          <div className="repair-file-list">
            {session.files.length ? session.files.map((change) => (
              <button
                type="button"
                key={change.path}
                className={change.path === activePath ? "active" : ""}
                onClick={() => setActivePath(change.path)}
              >
                <span className={`repair-change-mark ${change.status}`}>{change.status[0].toUpperCase()}</span>
                <span className="repair-file-name">{change.path}</span>
                <span className={`repair-risk ${change.risk}`}>{riskLabel[change.risk]}</span>
              </button>
            )) : <p className="empty-note">AI 尚未生成变更。可让 AI 分析失败链路，或先手动选择并编辑候选文件。</p>}
          </div>
        </aside>

        <main className="repair-diff">
          <div className="repair-diff-toolbar">
            <strong>{activePath ?? "请选择变更文件"}</strong>
            <button
              type="button"
              className="secondary-button"
              disabled={!file || draft === file.content || Boolean(busy)}
              onClick={() => file && act("正在保存", async () => {
                await onSaveFile(file, draft);
                const refreshed = await onLoadFile(file.path);
                setFile(refreshed);
                setDraft(refreshed.content);
                setMessage("沙盒文件已保存。");
              })}
            >
              保存沙盒修改
            </button>
          </div>
          {file ? (
            <DiffEditor
              height="62vh"
              language={languageFor(file.path)}
              original={file.original}
              modified={draft}
              onMount={(editor) => {
                editor.getModifiedEditor().onDidChangeModelContent(() => {
                  setDraft(editor.getModifiedEditor().getValue());
                });
              }}
              options={{
                automaticLayout: true,
                renderSideBySide: true,
                readOnly: !file.editable,
                minimap: { enabled: false },
                wordWrap: "on",
                fontSize: 13
              }}
            />
          ) : <div className="repair-diff-empty">变更生成后，可在这里逐行审查和编辑。</div>}
        </main>

        <aside className="repair-review">
          <strong>修复说明</strong>
          <dl>
            <div><dt>归因</dt><dd>{session.failureClass}</dd></div>
            <div><dt>状态</dt><dd>{session.status}</dd></div>
            <div><dt>修复轮次</dt><dd>{session.iteration}/2</dd></div>
            <div><dt>风险</dt><dd>{activeChange ? riskLabel[activeChange.risk] : "—"}</dd></div>
          </dl>
          {activeChange?.riskReasons.length ? (
            <div className="repair-warning">{activeChange.riskReasons.join("、")}</div>
          ) : null}
          <div className={`repair-validation ${session.validation?.status ?? "idle"}`}>
            <strong>验证结果</strong>
            <p>{session.validation?.summary ?? "尚未运行沙盒定向测试和完整回归。"}</p>
            {session.validation?.childRunId ? <code>{session.validation.childRunId}</code> : null}
          </div>
          {message ? <p className="repair-message">{message}</p> : null}
        </aside>
      </div>

      <footer className="repair-workspace-actions">
        <span>{busy ?? "原项目保持只读；所有编辑都发生在沙盒副本。"}</span>
        <div>
          <button type="button" disabled={Boolean(busy) || !session.files.length} onClick={() => act("正在重新验证", onValidate)}>重新验证</button>
          <button type="button" disabled={Boolean(busy) || !session.files.length} onClick={() => act("正在生成 Patch", async () => {
            const result = await onExport("patch");
            await downloadArtifact(result.downloadUrl, `${session.id}.patch`);
          })}>下载 Patch</button>
          <button type="button" disabled={Boolean(busy) || !session.files.length} onClick={() => act("正在生成 ZIP", async () => {
            const result = await onExport("zip");
            await downloadArtifact(result.downloadUrl, `${session.id}.zip`);
          })}>下载变更 ZIP</button>
          <button
            type="button"
            className="danger-button"
            disabled={Boolean(busy) || !canApply || session.validation?.status !== "passed"}
            onClick={() => {
              const hasHighRisk = session.files.some((item) => item.risk === "high");
              if (hasHighRisk && !window.confirm("变更包含认证、支付、迁移、CI 或基础设施等高风险文件。确认仍要应用到原项目？")) return;
              void act("正在应用到原项目", () => onApply(hasHighRisk));
            }}
            title={!canApply ? "当前部署禁止写入原项目" : undefined}
          >
            应用到原项目
          </button>
        </div>
      </footer>
    </section>
  );
}
