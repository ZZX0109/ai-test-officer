import { DiffEditor, Editor } from "@monaco-editor/react";
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { downloadArtifactBlob } from "../api";
import type { RepairFileContent, RepairSession, RepairWorkspaceFile } from "../types";

interface RepairWorkspaceProps {
  session: RepairSession;
  /** Render inside the central Preview/Code frame instead of creating a
   * second visual surface with its own mode controls. */
  embedded?: boolean;
  canApply?: boolean;
  onListFiles?: () => Promise<RepairWorkspaceFile[]>;
  onLoadFile: (path: string) => Promise<RepairFileContent>;
  onSaveFile: (file: RepairFileContent, content: string) => Promise<RepairSession>;
  onValidate: (allowNetworkInstall?: boolean) => Promise<RepairSession>;
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
  if (/\.mdx?$/.test(filePath)) return "markdown";
  if (/\.(?:sh|bash|zsh)$/.test(filePath)) return "shell";
  if (/\.sql$/.test(filePath)) return "sql";
  if (/\.go$/.test(filePath)) return "go";
  if (/\.rs$/.test(filePath)) return "rust";
  if (/\.java$/.test(filePath)) return "java";
  return "plaintext";
}

const riskLabel = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  forbidden: "禁止修改"
} as const;

const changeStatusLabel = {
  added: "新增文件",
  modified: "已修改",
  deleted: "已删除"
} as const;

type TextChangePreview = {
  originalStart: number;
  originalEnd: number;
  modifiedStart: number;
  modifiedEnd: number;
  removed: string[];
  added: string[];
};

/**
 * A concise, local explanation for the first changed block. Monaco remains
 * the source of truth for the complete diff; this prevents a reviewer from
 * having to scan two panes merely to learn what file change they are seeing.
 */
function previewTextChange(original: string, modified: string): TextChangePreview | undefined {
  if (original === modified) return undefined;
  const before = original.split(/\r?\n/);
  const after = modified.split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= prefix && afterEnd >= prefix && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return {
    originalStart: prefix + 1,
    originalEnd: Math.max(prefix + 1, beforeEnd + 1),
    modifiedStart: prefix + 1,
    modifiedEnd: Math.max(prefix + 1, afterEnd + 1),
    removed: before.slice(prefix, beforeEnd + 1),
    added: after.slice(prefix, afterEnd + 1)
  };
}

function shortCodeLine(value: string) {
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length > 112 ? `${compact.slice(0, 109)}…` : compact || "（空行）";
}

interface FileTreeNode {
  name: string;
  path: string;
  kind: "folder" | "file";
  file?: RepairWorkspaceFile;
  children: FileTreeNode[];
}

function buildFileTree(files: RepairWorkspaceFile[]): FileTreeNode[] {
  type MutableNode = Omit<FileTreeNode, "children"> & { children: Map<string, MutableNode> };
  const root = new Map<string, MutableNode>();
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let siblings = root;
    let currentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const isFile = index === parts.length - 1;
      let node = siblings.get(name);
      if (!node) {
        node = { name, path: currentPath, kind: isFile ? "file" : "folder", children: new Map(), ...(isFile ? { file } : {}) };
        siblings.set(name, node);
      }
      if (!isFile) siblings = node.children;
    }
  }

  const materialize = (nodes: Map<string, MutableNode>): FileTreeNode[] => [...nodes.values()]
    .map((node) => ({ ...node, children: materialize(node.children) }))
    .sort((left, right) => left.kind === right.kind
      ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
      : left.kind === "folder" ? -1 : 1);
  return materialize(root);
}

function preferredProjectFile(files: RepairWorkspaceFile[]) {
  const priorities = [
    /^README(?:\.[^.]+)?$/i,
    /^package\.json$/i,
    /^(?:src|app)\/(?:main|index|App)\.[jt]sx?$/i,
    /^(?:src|app)\/.*\.[jt]sx?$/i,
    /\.(?:ts|tsx|js|jsx|py|go|rs|java)$/i
  ];
  for (const pattern of priorities) {
    const match = files.find((file) => pattern.test(file.path) && !file.path.startsWith("."));
    if (match) return match.path;
  }
  return files.find((file) => !file.path.startsWith("."))?.path ?? files[0]?.path;
}

function ancestorFolders(filePath: string) {
  const parts = filePath.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function RepairWorkspace({
  session,
  embedded = false,
  canApply = false,
  onListFiles,
  onLoadFile,
  onSaveFile,
  onValidate,
  onExport,
  onApply,
  onClose
}: RepairWorkspaceProps) {
  const projectBrowseMode = session.runId.startsWith("code-session:");
  const [activePath, setActivePath] = useState(session.files[0]?.path);
  const [workspaceFiles, setWorkspaceFiles] = useState<RepairWorkspaceFile[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const [file, setFile] = useState<RepairFileContent>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState("");
  const [networkApprovalRequired, setNetworkApprovalRequired] = useState(false);
  const [diffView, setDiffView] = useState<"inline" | "split">("inline");
  const activeChange = useMemo(
    () => session.files.find((item) => item.path === activePath),
    [activePath, session.files]
  );
  const files = useMemo(() => {
    const byPath = new Map(workspaceFiles.map((item) => [item.path, item]));
    for (const change of session.files) {
      const existing = byPath.get(change.path);
      byPath.set(change.path, existing ?? {
        path: change.path,
        changed: true,
        risk: change.risk,
        riskReasons: change.riskReasons,
        editable: change.editable
      });
    }
    return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  }, [session.files, workspaceFiles]);
  const fileTree = useMemo(() => buildFileTree(files), [files]);
  const dependencyChange = useMemo(() => session.files.some((item) =>
    /(^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|poetry\.lock|uv\.lock)$/i.test(item.path)
  ), [session.files]);
  const textChangePreview = useMemo(
    () => file ? previewTextChange(file.original, draft) : undefined,
    [file?.original, draft]
  );
  const displayedAdditions = activeChange?.additions ?? textChangePreview?.added.length ?? 0;
  const displayedDeletions = activeChange?.deletions ?? textChangePreview?.removed.length ?? 0;

  async function requestValidation() {
    if (dependencyChange && !networkApprovalRequired) {
      setNetworkApprovalRequired(true);
      setMessage("本次变更包含依赖清单。验证需要在隔离沙盒中联网安装依赖；原项目不会被修改。请确认后继续。");
      return;
    }
    await onValidate(networkApprovalRequired);
    setNetworkApprovalRequired(false);
  }

  useEffect(() => {
    if (!onListFiles) return;
    let live = true;
    void onListFiles()
      .then((next) => live && setWorkspaceFiles(next))
      .catch((error) => live && setMessage(error instanceof Error ? error.message : "读取项目文件树失败"));
    return () => { live = false; };
  }, [onListFiles, session.id]);

  useEffect(() => {
    if (activePath && files.some((item) => item.path === activePath)) return;
    const nextPath = session.files[0]?.path ?? preferredProjectFile(files);
    setActivePath(nextPath);
    if (nextPath) {
      setExpandedFolders((current) => new Set([...current, ...ancestorFolders(nextPath)]));
    }
  }, [activePath, files, session.files]);

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

  function toggleFolder(folderPath: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }

  function renderTree(nodes: FileTreeNode[], depth = 0): ReactNode {
    return nodes.map((node) => {
      if (node.kind === "folder") {
        const expanded = expandedFolders.has(node.path);
        return (
          <div className="project-tree-branch" key={node.path}>
            <button
              type="button"
              className="project-tree-row folder"
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              aria-expanded={expanded}
              onClick={() => toggleFolder(node.path)}
            >
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span title={node.path}>{node.name}</span>
            </button>
            {expanded ? renderTree(node.children, depth + 1) : null}
          </div>
        );
      }
      const workspaceFile = node.file!;
      const change = session.files.find((item) => item.path === workspaceFile.path);
      const showRisk = workspaceFile.risk === "high" || workspaceFile.risk === "forbidden";
      return (
        <button
          type="button"
          key={workspaceFile.path}
          className={`project-tree-row file${workspaceFile.path === activePath ? " active" : ""}`}
          style={{ paddingLeft: `${23 + depth * 14}px` }}
          onClick={() => setActivePath(workspaceFile.path)}
          title={workspaceFile.path}
        >
          <FileCode2 size={14} />
          <span className="repair-file-name">{node.name}</span>
          {change ? <span className={`repair-change-letter ${change.status}`}>{change.status[0].toUpperCase()}</span> : null}
          {showRisk ? <span className={`repair-risk ${workspaceFile.risk}`}>{riskLabel[workspaceFile.risk]}</span> : null}
        </button>
      );
    });
  }

  return (
    <section className={`repair-workspace${embedded ? " embedded" : ""}`} aria-label="项目代码工作区">
      {!embedded ? <header className="repair-workspace-header">
        <div>
          <span className="eyebrow">沙盒代码修复</span>
          <h2>修复工作区</h2>
          <p>{session.summary}</p>
        </div>
        <button type="button" className="secondary-button" onClick={onClose}>返回预览</button>
      </header> : null}

      <div className={`repair-workspace-grid${projectBrowseMode ? " project-browse" : ""}`}>
        <aside className="repair-file-tree">
          <div className="project-tree-heading">
            <strong>资源管理器</strong>
            <span>{files.length} 个文件{session.files.length ? ` · ${session.files.length} 个改动` : ""}</span>
          </div>
          <div className="repair-file-list" role="tree" aria-label="项目文件">
            {files.length ? renderTree(fileTree) : <p className="empty-note">正在读取受控的项目文件树…</p>}
          </div>
        </aside>

        <main className="repair-diff">
          <div className="repair-diff-toolbar">
            <div className="repair-diff-title">
              <strong title={activePath}>{activePath ?? "请选择变更文件"}</strong>
              {activeChange ? <span className={`repair-diff-status ${activeChange.status}`}>{changeStatusLabel[activeChange.status]} · <b>+{displayedAdditions}</b> / <b>-{displayedDeletions}</b> · {riskLabel[activeChange.risk]}</span> : null}
            </div>
            <div className="repair-diff-toolbar-actions">
              {!projectBrowseMode ? <div className="repair-diff-view-toggle" role="group" aria-label="对比显示方式">
                <button type="button" className={diffView === "inline" ? "active" : ""} aria-pressed={diffView === "inline"} onClick={() => setDiffView("inline")}>行内对比</button>
                <button type="button" className={diffView === "split" ? "active" : ""} aria-pressed={diffView === "split"} onClick={() => setDiffView("split")}>并排对比</button>
              </div> : null}
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
          </div>
          {!projectBrowseMode && activeChange ? <section className="repair-change-summary" aria-label="当前文件的改动摘要">
            <div>
              <strong>这个文件改了什么</strong>
              <span>红色删除，绿色新增；默认按行内显示。</span>
            </div>
            {textChangePreview ? <div className="repair-change-preview">
              <span className="repair-change-lines">原第 {textChangePreview.originalStart}–{textChangePreview.originalEnd} 行 → 新第 {textChangePreview.modifiedStart}–{textChangePreview.modifiedEnd} 行</span>
              {textChangePreview.removed.slice(0, 2).map((line, index) => <code className="removed" key={`removed-${index}`}>− {shortCodeLine(line)}</code>)}
              {textChangePreview.added.slice(0, 2).map((line, index) => <code className="added" key={`added-${index}`}>+ {shortCodeLine(line)}</code>)}
            </div> : <p>当前沙盒内容与基线相同；没有可展示的文本差异。</p>}
          </section> : null}
          {file ? projectBrowseMode ? (
            <Editor
              height="62vh"
              language={languageFor(file.path)}
              theme="ato-vscode-light"
              value={draft}
              onChange={(value) => setDraft(value ?? "")}
              loading="正在载入代码编辑器…"
              options={{
                automaticLayout: true,
                readOnly: !file.editable,
                minimap: { enabled: true },
                wordWrap: "on",
                fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
                fontLigatures: true,
                fontSize: 13,
                lineHeight: 20,
                bracketPairColorization: { enabled: true },
                guides: { bracketPairs: true, indentation: true },
                renderLineHighlight: "all",
                smoothScrolling: true,
                scrollBeyondLastLine: false
              }}
            />
          ) : (
            <DiffEditor
              height="62vh"
              language={languageFor(file.path)}
              theme="ato-vscode-light"
              original={file.original}
              modified={draft}
              onMount={(editor) => {
                editor.getModifiedEditor().onDidChangeModelContent(() => {
                  setDraft(editor.getModifiedEditor().getValue());
                });
              }}
              loading="正在载入变更对比…"
              options={{
                automaticLayout: true,
                renderSideBySide: diffView === "split",
                readOnly: !file.editable,
                minimap: { enabled: false },
                wordWrap: "on",
                fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
                fontLigatures: true,
                fontSize: 13,
                lineHeight: 20,
                bracketPairColorization: { enabled: true },
                guides: { bracketPairs: true, indentation: true },
                renderLineHighlight: "all",
                smoothScrolling: true
              }}
            />
          ) : <div className="repair-diff-empty">{busy ?? "请从左侧选择一个文件。"}</div>}
        </main>

        {!projectBrowseMode ? <aside className="repair-review">
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
          <div className="repair-rationale">
            <strong>修复依据</strong>
            <p><b>为什么需要改：</b>{session.summary || "系统正在根据失败证据定位最小修复。"}</p>
            <p><b>本文件的实际改动：</b>{activeChange ? `${changeStatusLabel[activeChange.status]}，${displayedAdditions} 行新增、${displayedDeletions} 行删除；完整内容请看中央行内对比。` : "请先从文件树中选择一项改动。"}</p>
            <p><b>如何验证：</b>{session.validation?.summary || "将在沙盒中执行定向测试、相关回归和完整回归。"}</p>
            <small>当前改动只在沙盒副本中。只有验证通过且你明确确认后，才可应用到原项目。</small>
          </div>
          {message ? <p className="repair-message">{message}</p> : null}
        </aside> : null}
      </div>

      <footer className="repair-workspace-actions">
        <span>{busy ?? "原项目保持只读；所有编辑都发生在沙盒副本。"}</span>
        {!projectBrowseMode ? <div>
          <button
            type="button"
            disabled={Boolean(busy) || !session.files.length}
            onClick={() => act(networkApprovalRequired ? "正在联网安装并验证" : "正在重新验证", requestValidation)}
          >
            {networkApprovalRequired ? "授权联网并验证" : "重新验证"}
          </button>
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
          <button
            type="button"
            className="repair-discard-button"
            disabled={Boolean(busy)}
            onClick={() => {
              if (!window.confirm("丢弃本次修复？沙盒副本与补丁将不应用到原项目，原项目保持不变。")) return;
              onClose();
            }}
            title="不应用任何改动，关闭修复工作区"
          >
            丢弃修复
          </button>
        </div> : <span>保存按钮只更新当前沙盒副本。</span>}
      </footer>
    </section>
  );
}
