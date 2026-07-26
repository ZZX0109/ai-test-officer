import type { ProjectConfig } from "./types";

const PROJECT_HISTORY_CACHE_KEY = "ai-test-officer.recent-projects.v1";

export function isVisibleProject(project: Pick<ProjectConfig, "id" | "name">) {
  return !/(?:^|[_-])(selftest|self_test)(?:[_-]|$)|runtime[_-]?unavailable.*selftest/i.test(`${project.id} ${project.name}`);
}

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function safeProject(project: ProjectConfig): ProjectConfig {
  return {
    ...project,
    env: undefined,
    login: project.login ? { ...project.login, credentialId: undefined } : undefined
  };
}

export function readProjectHistoryCache(): ProjectConfig[] {
  try {
    const raw = storage()?.getItem(PROJECT_HISTORY_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((project): project is ProjectConfig => {
      if (!project || typeof project !== "object") return false;
      const candidate = project as Partial<ProjectConfig>;
      return typeof candidate.id === "string"
        && typeof candidate.name === "string"
        && typeof candidate.projectPath === "string"
        && typeof candidate.frontendUrl === "string"
        && isVisibleProject(candidate as Pick<ProjectConfig, "id" | "name">);
    });
  } catch {
    return [];
  }
}

export function writeProjectHistoryCache(projects: ProjectConfig[]): void {
  try {
    storage()?.setItem(PROJECT_HISTORY_CACHE_KEY, JSON.stringify(projects.filter(isVisibleProject).map(safeProject)));
  } catch {
    // This cache only improves offline display; storage restrictions must not block Workbench.
  }
}
