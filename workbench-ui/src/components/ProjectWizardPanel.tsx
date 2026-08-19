import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, File, Folder, FolderOpen, FolderSearch, Info, Upload } from "lucide-react";
import type { ProjectConfig, ProjectDetectionResult } from "../types";
import { chooseProjectFolder, listProjectDirectory } from "../api";
import { buildFileTree, type FileTreeNode } from "../projectFileTree";

function FileTree({ nodes, expandedPaths, loadingPaths, onToggle }: {
  nodes: FileTreeNode[];
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  onToggle: (path: string) => void | Promise<void>;
}) {
  const batchSize = 200;
  const [visibleCount, setVisibleCount] = useState(batchSize);
  useEffect(() => setVisibleCount(batchSize), [nodes]);
  const visibleNodes = nodes.slice(0, visibleCount);
  return (
    <ul className="project-file-tree" aria-label="项目文件夹目录">
      {visibleNodes.map((node) => {
        const isExpanded = node.kind === "directory" && expandedPaths.has(node.path);
        return (
          <li className={`project-file-tree__node project-file-tree__node--${node.kind}`} key={node.path}>
            {node.kind === "directory" ? (
              <button
                className="project-file-tree__toggle"
                type="button"
                aria-expanded={isExpanded}
                aria-label={`${isExpanded ? "收起" : "展开"} ${node.name}`}
                onClick={() => void onToggle(node.path)}
              >
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                <span>{node.name}</span>
                {loadingPaths.has(node.path) ? <small>读取中…</small> : null}
              </button>
            ) : (
              <div className="project-file-tree__file">
                <File size={14} />
                <span>{node.name}</span>
              </div>
            )}
            {node.kind === "directory" && isExpanded ? (
              <FileTree nodes={node.children} expandedPaths={expandedPaths} loadingPaths={loadingPaths} onToggle={onToggle} />
            ) : null}
          </li>
        );
      })}
      {visibleCount < nodes.length ? (
        <li className="project-file-tree__more">
          <button type="button" onClick={() => setVisibleCount((current) => Math.min(nodes.length, current + batchSize))}>
            再显示 {Math.min(batchSize, nodes.length - visibleCount)} 项
            <span>（本目录共 {nodes.length} 项）</span>
          </button>
        </li>
      ) : null}
    </ul>
  );
}

interface ProjectWizardPanelProps {
  projects: ProjectConfig[];
  selectedProjectId: string;
  projectPath: string;
  detection?: ProjectDetectionResult | null;
  onSelectProject: (id: string) => void;
  onProjectPathChange: (value: string) => void;
  onDetect: (selection: {
    rootName: string;
    absolutePath?: string;
    files: Array<{ relativePath: string; content?: string }>;
  }) => void | Promise<void>;
  detectMessage?: string;
  projectListNotice?: string;
}

export function ProjectWizardPanel({
  projects,
  selectedProjectId,
  projectPath,
  detection,
  onSelectProject,
  onProjectPathChange,
  onDetect,
  detectMessage,
  projectListNotice
}: ProjectWizardPanelProps) {
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const selectedFirstFileRef = useRef<(File & { path?: string }) | null>(null);
  const selectedManifestFilesRef = useRef<File[]>([]);
  const selectionGenerationRef = useRef(0);
  const [selectedFileCount, setSelectedFileCount] = useState(0);
  const [selectedRootName, setSelectedRootName] = useState("");
  const [nativeProjectPath, setNativeProjectPath] = useState("");
  const [fileTree, setFileTree] = useState<FileTreeNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [selectingFolder, setSelectingFolder] = useState(false);
  const [indexingFiles, setIndexingFiles] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const systemProjectIds = new Set([
    "customer_portal_lite",
    "investment_agent_workflow_external",
    "local_demo_app",
    "order_portal_lite",
    "todo_lite"
  ]);
  const recentProjects = projects.filter((project) => !systemProjectIds.has(project.id));

  function nativeEntries(rootName: string, entries: Awaited<ReturnType<typeof listProjectDirectory>>["entries"]): FileTreeNode[] {
    return entries.map((entry) => ({
      name: entry.name,
      path: `${rootName}/${entry.relativePath}`,
      relativePath: entry.relativePath,
      kind: entry.kind,
      children: [],
      childrenLoaded: entry.kind === "file"
    }));
  }

  async function selectProjectFolder() {
    setSelectingFolder(true);
    try {
      const response = await chooseProjectFolder();
      if (response.selection.status === "cancelled") return;
      if (response.selection.status === "unsupported") {
        folderInputRef.current?.click();
        return;
      }
      const { projectPath: selectedPath, rootName } = response.selection;
      onSelectProject("");
      selectionGenerationRef.current += 1;
      selectedFirstFileRef.current = null;
      selectedManifestFilesRef.current = [];
      setSelectedFileCount(0);
      setSelectedRootName(rootName);
      setNativeProjectPath(selectedPath);
      setIndexingFiles(false);
      onProjectPathChange(selectedPath);
      const directory = await listProjectDirectory({ projectPath: selectedPath });
      const root: FileTreeNode = {
        name: rootName,
        path: rootName,
        relativePath: "",
        kind: "directory",
        children: nativeEntries(rootName, directory.entries),
        childrenLoaded: true
      };
      setFileTree([root]);
      setExpandedPaths(new Set([rootName]));
    } catch {
      // The browser upload remains available when the native local bridge is
      // unavailable, for example in a remote or non-macOS deployment.
      folderInputRef.current?.click();
    } finally {
      setSelectingFolder(false);
    }
  }

  function handleFolderSelected(event: ChangeEvent<HTMLInputElement>) {
    const fileList = event.target.files;
    if (!fileList?.length) return;
    // A new upload is a new project context. Clear the historical selection
    // before rendering the new tree so the dropdown cannot keep showing the
    // previously selected project name.
    onSelectProject("");
    setNativeProjectPath("");
    const generation = ++selectionGenerationRef.current;
    setIndexingFiles(true);
    setSelectedFileCount(fileList.length);
    const schedule = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (callback: FrameRequestCallback) => window.setTimeout(callback, 0);
    schedule(() => {
      if (generation !== selectionGenerationRef.current) return;
      try {
        const paths: string[] = [];
        const manifestFiles: File[] = [];
        for (let index = 0; index < fileList.length; index += 1) {
          const file = fileList.item(index);
          if (!file) continue;
          const relativePath = file.webkitRelativePath || file.name;
          paths.push(relativePath);
          if (/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|uv\.lock|poetry\.lock|vite\.config\.[^/]+|next\.config\.[^/]+|app\.py)$/i.test(relativePath)) {
            manifestFiles.push(file);
          }
        }
        const root = paths[0]?.split("/")[0] ?? projectPath;
        const firstFile = fileList.item(0) as (File & { path?: string }) | null;
        const firstRelativePath = firstFile?.webkitRelativePath || firstFile?.name || "";
        const relativeTail = firstRelativePath.split("/").slice(1).join("/");
        const absolutePath = firstFile?.path && relativeTail && firstFile.path.endsWith(relativeTail)
          ? firstFile.path.slice(0, -relativeTail.length).replace(/[\\/]$/, "")
          : undefined;
        const nextTree = buildFileTree(paths);
        selectedFirstFileRef.current = firstFile;
        selectedManifestFilesRef.current = manifestFiles.slice(0, 250);
        setSelectedRootName(root);
        setFileTree(nextTree);
        // Only expand the project root initially. Large build directories stay
        // collapsed until requested and therefore do not block the main thread.
        setExpandedPaths(new Set(nextTree.filter((node) => node.kind === "directory").map((node) => node.path)));
        onProjectPathChange(absolutePath ?? root);
      } finally {
        setIndexingFiles(false);
      }
    });
  }

  function findTreeNode(nodes: FileTreeNode[], targetPath: string): FileTreeNode | undefined {
    for (const node of nodes) {
      if (node.path === targetPath) return node;
      const nested = findTreeNode(node.children, targetPath);
      if (nested) return nested;
    }
    return undefined;
  }

  function replaceTreeNodeChildren(nodes: FileTreeNode[], targetPath: string, children: FileTreeNode[]): FileTreeNode[] {
    return nodes.map((node) => node.path === targetPath
      ? { ...node, children, childrenLoaded: true }
      : { ...node, children: replaceTreeNodeChildren(node.children, targetPath, children) });
  }

  async function toggleDirectory(path: string) {
    const opening = !expandedPaths.has(path);
    const node = findTreeNode(fileTree, path);
    if (opening && nativeProjectPath && node?.kind === "directory" && !node.childrenLoaded) {
      setLoadingPaths((current) => new Set(current).add(path));
      try {
        const directory = await listProjectDirectory({
          projectPath: nativeProjectPath,
          relativePath: node.relativePath
        });
        setFileTree((current) => replaceTreeNodeChildren(current, path, nativeEntries(selectedRootName, directory.entries)));
      } finally {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleDetect() {
    setDetecting(true);
    try {
      if (nativeProjectPath) {
        await onDetect({
          rootName: selectedRootName || nativeProjectPath.split("/").filter(Boolean).at(-1) || "selected-project",
          absolutePath: nativeProjectPath,
          files: []
        });
        return;
      }
      const relevantFiles = selectedManifestFilesRef.current;
      const manifestFiles = await Promise.all(relevantFiles.map(async (file) => ({
        relativePath: file.webkitRelativePath || file.name,
        content: /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|vite\.config\.[^/]+)$/i.test(file.webkitRelativePath || file.name)
          ? await file.slice(0, 300_000).text()
          : undefined
      })));
      const firstFile = selectedFirstFileRef.current ?? undefined;
      const firstRelativePath = firstFile?.webkitRelativePath || firstFile?.name || "";
      const rootName = firstRelativePath.split("/")[0] || projectPath;
      const relativeTail = firstRelativePath.split("/").slice(1).join("/");
      const absolutePath = firstFile?.path && relativeTail && firstFile.path.endsWith(relativeTail)
        ? firstFile.path.slice(0, -relativeTail.length).replace(/[\\/]$/, "")
        : undefined;
      await onDetect({ rootName, absolutePath, files: manifestFiles });
    } finally {
      setDetecting(false);
    }
  }

  const hasFolderSelection = Boolean(nativeProjectPath || selectedFileCount);

  return (
    <section className="wizard-box">
      <label className="recent-project-picker">
        之前接入的项目
        <select
          disabled={!recentProjects.length}
          value={recentProjects.some((project) => project.id === selectedProjectId) ? selectedProjectId : ""}
          onChange={(event) => onSelectProject(event.target.value)}
        >
          <option value="">{recentProjects.length ? "请选择" : "暂无可用的历史项目"}</option>
          {recentProjects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
        {projectListNotice ? <small role="status">{projectListNotice}</small> : null}
      </label>
      <input
        ref={(node) => {
          folderInputRef.current = node;
          node?.setAttribute("webkitdirectory", "");
        }}
        className="project-folder-input"
        type="file"
        multiple
        onChange={handleFolderSelected}
        aria-label="选择项目文件夹"
      />
      <div className="project-identify-actions project-identify-actions--inline">
        <button type="button" onClick={() => void selectProjectFolder()} disabled={selectingFolder}>
          <Upload size={15} />
          {selectingFolder ? "正在打开 Finder…" : hasFolderSelection ? "重新上传项目" : "上传新项目"}
        </button>
        <button className="primary" type="button" onClick={() => void handleDetect()} disabled={!hasFolderSelection || indexingFiles || detecting}>
          <FolderSearch size={15} />
          {indexingFiles ? "正在整理目录…" : detecting ? "正在识别…" : "识别项目"}
        </button>
      </div>
      {hasFolderSelection ? (
        <div className="project-upload-box has-files">
          <div className="project-file-browser">
            <div className="project-file-browser-header">
              <div>
                <strong>{projectPath || selectedRootName || "已选择项目"}</strong>
                <span>{nativeProjectPath ? "本机目录 · 按需读取" : indexingFiles ? `正在整理 ${selectedFileCount} 个文件…` : `${selectedFileCount} 个文件`}</span>
              </div>
            </div>
            {indexingFiles ? <div className="project-file-tree-loading">正在建立文件索引，不读取依赖内容…</div> : (
              <FileTree nodes={fileTree} expandedPaths={expandedPaths} loadingPaths={loadingPaths} onToggle={toggleDirectory} />
            )}
            <p>{nativeProjectPath ? "目录由 Agent 按需读取；选择时不再枚举全部文件。" : `完整目录共 ${selectedFileCount} 个文件；大型目录按需展开并分批显示。`}</p>
          </div>
        </div>
      ) : null}
      {detectMessage ? <p className="project-detect-status" role="status">{detectMessage}</p> : null}

      {detection && (!detection.exists || detection.executionReady === false) ? (
        <article className={`wizard-result ${detection.exists ? detection.executionReady === false ? "warning" : "passed" : "failed"}`}>
          <header>
            <div>
              <strong>{detection.exists ? detection.executionReady === false ? "已识别项目类型，等待完整路径" : "已找到项目" : "暂时找不到这个项目文件夹"}</strong>
              <p>{detection.exists ? `看起来是 ${detection.detectedStack.join(" + ") || "一个可测试的项目"}。` : "请检查文件夹名称或填写完整路径后重试。"}</p>
            </div>
            {detection.exists && detection.executionReady !== false ? <CheckCircle2 aria-label="识别成功" size={19} /> : null}
          </header>
          {detection.exists ? (
            <div className="wizard-next-step">
              <div>
                <span>下一步</span>
                <p>{detection.executionReady === false ? "项目类型已经识别；补充可执行路径后即可继续。" : "请在下方确认系统识别到的项目信息和推荐运行设置。"}</p>
              </div>
            </div>
          ) : null}
          {detection.plainLanguageFixes.map((fix) => (
            <p key={fix}>怎么修：{fix}</p>
          ))}
          {detection.warnings.map((warning) => (
            <p key={warning}>注意：{warning}</p>
          ))}
          {detection.externalServiceDependencies?.length ? (
            <div className="wizard-external-deps" role="alert">
              <strong>外部依赖（沙盒未提供）</strong>
              <p>该项目引用了沙盒不提供的外部数据库 / 缓存 / 队列 / 搜索 / 云服务。直接启动会失败或降级运行，请先配置或知悉：</p>
              <ul>
                {detection.externalServiceDependencies.map((dep) => <li key={dep}>{dep}</li>)}
              </ul>
            </div>
          ) : null}
          {detection.exists ? (
            <details className="wizard-details">
              <summary><Info size={14} /> 查看系统识别到的技术信息</summary>
              <p>依赖安装工具：{detection.packageManagers.join(", ") || "未识别或不需要"}（用于安装项目运行所需的代码包）</p>
              <p>建议启动方式：{detection.suggestedConfig.startCommand ?? "需要手动填写"}</p>
              <p>检查地址：{detection.suggestedConfig.healthCheckUrl ?? detection.healthCandidates[0] ?? "需要手动填写"}</p>
              <div className="chip-list">
                {detection.ports.map((port) => (
                  <span key={`${port.purpose}-${port.port}`}>
                    {port.purpose}:{port.port} {port.status}
                  </span>
                ))}
              </div>
            </details>
          ) : null}
        </article>
      ) : null}

    </section>
  );
}
