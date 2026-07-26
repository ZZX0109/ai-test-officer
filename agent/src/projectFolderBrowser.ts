import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProjectDirectoryEntry {
  name: string;
  relativePath: string;
  kind: "directory" | "file";
}

export async function chooseNativeProjectFolder(): Promise<
  | { status: "selected"; projectPath: string; rootName: string }
  | { status: "cancelled" }
  | { status: "unsupported"; reason: string }
> {
  if (process.env.NODE_ENV !== "development") {
    return { status: "unsupported", reason: "native_folder_picker_development_only" };
  }
  if (process.platform !== "darwin") {
    return { status: "unsupported", reason: "native_folder_picker_requires_macos" };
  }
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "选择要测试的项目文件夹")'
    ], {
      timeout: 5 * 60_000,
      maxBuffer: 64 * 1024
    });
    const selectedPath = path.resolve(stdout.trim());
    if (selectedPath === path.parse(selectedPath).root) {
      return { status: "unsupported", reason: "filesystem_root_cannot_be_selected" };
    }
    return {
      status: "selected",
      projectPath: selectedPath,
      rootName: path.basename(selectedPath)
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/user canceled|cancelled|canceled|-128/i.test(detail)) return { status: "cancelled" };
    return { status: "unsupported", reason: "native_folder_picker_failed" };
  }
}

export async function listProjectDirectory(input: {
  projectPath: string;
  relativePath?: string;
}): Promise<ProjectDirectoryEntry[]> {
  const projectRoot = path.resolve(input.projectPath);
  const relativePath = input.relativePath?.replaceAll("\\", "/").replace(/^\/+/, "") ?? "";
  const directory = path.resolve(projectRoot, relativePath);
  const relation = path.relative(projectRoot, directory);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error("project_directory_path_escape");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({
      name: entry.name,
      relativePath: relativePath ? `${relativePath}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? "directory" as const : "file" as const
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}
