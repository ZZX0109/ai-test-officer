// Pre-flight private-dependency detection. Runs BEFORE the sandbox install so
// that a project needing a private registry / SSH key / private index fails
// fast at the "sandbox run" step with a clear blocker, instead of installing
// halfway and exiting with a generic "early_exit" that hides the real cause.
//
// DI for the filesystem read so the core detection is unit-testable and free of
// a direct node:fs import (mirrors sandboxImageReadiness.ts). The thin
// `ensureDependenciesInstallable` wrapper below is the only fs-coupled glue.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig, ProjectRuntimeStatus } from "./types.js";

export interface PrivateDependencyFinding {
  blocked: boolean;
  /** Human-readable, lists each missing credential/config. */
  reason: string;
  /** Which installer stack the first blocker came from. */
  stack: "node" | "python" | "go" | "rust" | "java" | "ruby" | "php" | "unknown";
}

export interface DependencyReadinessContext {
  /** Read a file relative to the project root; undefined when it does not exist. */
  readProjectFile: (relativePath: string) => Promise<string | undefined>;
}

const PUBLIC_NPM_HOSTS = /registry\.npmjs\.org/i;
const PUBLIC_PY_HOSTS = /pypi\.org|files\.pythonhosted\.org/i;

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect private dependencies the sandbox cannot install without credentials
 * the user has not supplied. Returns undefined when nothing blocks the install.
 */
export async function detectPrivateDependencyBlocker(
  ctx: DependencyReadinessContext
): Promise<PrivateDependencyFinding | undefined> {
  const blockers: { stack: PrivateDependencyFinding["stack"]; message: string }[] = [];

  /** A dependency reference that requires an SSH key the sandbox does not hold:
   * git@host:, ssh://, git+ssh://, or git+https://user@ (embedded creds). */
  const hasPrivateGitRef = (text: string) => /git@[\w.-]+:|git\+ssh:\/\/|ssh:\/\/git@|git\+https:\/\/[^/\s"']+@/i.test(text);

  // --- npm / pnpm / yarn (.npmrc) ---
  const npmrc = await ctx.readProjectFile(".npmrc");
  if (npmrc) {
    const registryLines = [...npmrc.matchAll(/^(?:@[\w.-]+:)?registry\s*=\s*(https?:\/\/\S+)\s*$/gim)];
    for (const match of registryLines) {
      const registryUrl = match[1];
      if (PUBLIC_NPM_HOSTS.test(registryUrl)) continue; // public default, no auth needed
      const host = hostOf(registryUrl);
      if (!host) continue;
      // The sandbox can install from a private registry only if an auth token
      // for that host is present in .npmrc (or injected via env). A bare
      // registry line with no matching _authToken/_auth/_password means the
      // install will 401 inside the sandbox.
      const hostScoped = new RegExp(`//${escapeForRegex(host)}/:(?:_authToken|_auth|_password)\\s*=`, "i");
      const hasScopedAuth = hostScoped.test(npmrc);
      const hasLegacyAuth = new RegExp(`^\\s*${escapeForRegex(host)}\\s*=`, "im").test(npmrc);
      if (!hasScopedAuth && !hasLegacyAuth) {
        blockers.push({
          stack: "node",
          message: `npm 私有 registry ${registryUrl} 缺少认证（.npmrc 需配置 //${host}/:_authToken 或在沙盒注入对应环境变量）`
        });
      }
    }
  }

  // --- pip (requirements.txt / pip.conf) ---
  const requirementsTxt = await ctx.readProjectFile("requirements.txt");
  const pipConf = await ctx.readProjectFile("pip.conf");
  const pipText = [requirementsTxt, pipConf].filter(Boolean).join("\n");
  if (pipText) {
    const indexMatches = [...pipText.matchAll(/--(?:extra-)?index-url\s+(https?:\/\/\S+)/gi)];
    for (const match of indexMatches) {
      const indexUrl = match[1];
      if (PUBLIC_PY_HOSTS.test(indexUrl)) continue;
      blockers.push({
        stack: "python",
        message: `pip 私有 index ${indexUrl} 需要凭据（沙盒无对应账号/令牌）`
      });
    }
    // git+ssh / git@host: deps require an SSH key the sandbox does not have.
    if (/git\+ssh:\/\/|git@[\w.-]+:|git\+https:\/\/[^/\s]+@/i.test(pipText)) {
      blockers.push({
        stack: "python",
        message: "pip 依赖含 git+ssh / 私有 git 仓库（沙盒无 SSH key，无法克隆）"
      });
    }
  }

  // --- go (go.mod) ---
  // A `replace` directive pointing at a private git URL (git@/ssh://) needs an
  // SSH key the sandbox does not have. require/replace of a private VCS path
  // without GOPRIVATE + credentials would fail at `go mod download`.
  const goMod = await ctx.readProjectFile("go.mod");
  if (goMod) {
    const replacePrivate = /^\s*replace\s+\S+\s+=>\s*(?:git@|ssh:\/\/|git\+ssh:\/\/)/im.test(goMod);
    if (replacePrivate || hasPrivateGitRef(goMod)) {
      blockers.push({
        stack: "go",
        message: "go.mod replace/依赖指向私有 git（git@/ssh，沙盒无 SSH key，无法 go mod download）"
      });
    }
    // GOPRIVATE declared in the project (rare) signals private modules the
    // sandbox cannot authenticate. Surface it so the install does not 401.
    const goEnv = await ctx.readProjectFile(".env");
    if (goEnv && /^GOPRIVATE\s*=\s*\S+/m.test(goEnv)) {
      blockers.push({
        stack: "go",
        message: "项目声明 GOPRIVATE（私有模块），沙盒无对应凭据，go mod download 会失败"
      });
    }
  }

  // --- cargo (Cargo.toml + .cargo/config.toml) ---
  const cargoToml = await ctx.readProjectFile("Cargo.toml");
  if (cargoToml && hasPrivateGitRef(cargoToml)) {
    blockers.push({
      stack: "rust",
      message: "Cargo.toml 依赖含私有 git（git@/ssh，沙盒无 SSH key，无法 cargo fetch）"
    });
  }
  const cargoConfig = await ctx.readProjectFile(".cargo/config.toml");
  if (cargoConfig) {
    // A private registry index (anything other than crates.io) requires a
    // token in ~/.cargo/credentials.toml, which the sandbox does not hold.
    const privateIndex = /\bindex\s*=\s*"(https?:\/\/(?!github\.com|gitlab\.com|crates\.io)[^"]+)"/i.test(cargoConfig)
      || /\bregistry\s*=\s*"(ssh:\/\/|git@)/i.test(cargoConfig);
    if (privateIndex) {
      blockers.push({
        stack: "rust",
        message: ".cargo/config.toml 声明私有 registry（非 crates.io），沙盒无 cargo 令牌，无法拉取"
      });
    }
  }

  // --- maven (pom.xml) ---
  const pomXml = await ctx.readProjectFile("pom.xml");
  if (pomXml) {
    // A <repository>/<pluginRepository> URL outside Maven Central / GitHub /
    // GitLab needs a matching <server> credential in settings.xml, which the
    // sandbox does not have. ssh: scm also needs an SSH key.
    const repoMatches = [...pomXml.matchAll(/<(?:plugin)?repository>[\s\S]*?<url>\s*(https?:\/\/\S+?)\s*<\/url>/gi)];
    for (const match of repoMatches) {
      const repoUrl = match[1];
      if (/repo\.maven\.apache\.org|central\.maven\.com|github\.com|gitlab\.com|oss\.sonatype\.org/i.test(repoUrl)) continue;
      blockers.push({
        stack: "java",
        message: `pom.xml 仓库 ${repoUrl} 非公共 Maven Central，沙盒无 <server> 凭据，依赖解析会 401`
      });
      break;
    }
    if (/scm:git:ssh:\/\/|scm:git:git@/i.test(pomXml)) {
      blockers.push({
        stack: "java",
        message: "pom.xml scm 指向私有 git（ssh/git@，沙盒无 SSH key，无法拉取源码）"
      });
    }
  }

  // --- bundler (Gemfile) ---
  const gemfile = await ctx.readProjectFile("Gemfile");
  if (gemfile) {
    if (hasPrivateGitRef(gemfile) || /git:\s*["'](?:git@|ssh:\/\/)/i.test(gemfile)) {
      blockers.push({
        stack: "ruby",
        message: "Gemfile 依赖含私有 git（git: git@/ssh，沙盒无 SSH key，无法 bundle install）"
      });
    }
    // A private gem source (non-rubygems) needs Bundler credentials the sandbox lacks.
    const sourceMatch = /^\s*source\s+["'](https?:\/\/[^"']+)["']/im.exec(gemfile);
    if (sourceMatch && !/rubygems\.org|index\.rubygems\.org/i.test(sourceMatch[1])) {
      blockers.push({
        stack: "ruby",
        message: `Gemfile 私有 source ${sourceMatch[1]} 非公共 rubygems，沙盒无凭据，bundle install 会 401`
      });
    }
  }

  // --- composer (composer.json) ---
  const composerJson = await ctx.readProjectFile("composer.json");
  if (composerJson) {
    // A private repository (non-packagist) needs auth.json credentials the
    // sandbox does not have. Detect an explicit url outside packagist.org.
    const privateRepo = /"url"\s*:\s*"(https?:\/\/(?!repo\.packagist\.org)[^"]+)"/i.test(composerJson);
    if (privateRepo) {
      blockers.push({
        stack: "php",
        message: "composer.json 声明私有 repository（非 packagist），沙盒无 auth.json 凭据，composer install 会 401"
      });
    }
    if (hasPrivateGitRef(composerJson)) {
      blockers.push({
        stack: "php",
        message: "composer.json 依赖含私有 git（git@/ssh，沙盒无 SSH key，无法克隆）"
      });
    }
  }

  if (!blockers.length) return undefined;
  return {
    blocked: true,
    reason: blockers.map((item) => item.message).join("；"),
    stack: blockers[0].stack
  };
}

// Thin fs-coupled glue used by the start preflight: run the pure detection
// against the real project tree and, on a block, build the runtime failure
// status. Returns undefined when the install may proceed.
export async function ensureDependenciesInstallable(
  project: ProjectConfig,
  cwd: string,
  now: () => string
): Promise<ProjectRuntimeStatus | undefined> {
  const finding = await detectPrivateDependencyBlocker({
    readProjectFile: async (relativePath) => {
      try {
        return await readFile(path.join(cwd, relativePath), "utf8");
      } catch {
        return undefined;
      }
    }
  });
  if (!finding?.blocked) return undefined;
  return {
    projectId: project.id,
    status: "failed",
    phase: "failed",
    updatedAt: now(),
    stoppedAt: now(),
    failureReason: "dependency_missing",
    frontendUrl: project.frontendUrl,
    backendUrl: project.backendUrl,
    healthCheckUrl: project.healthCheckUrl,
    message: `依赖安装被阻塞：${finding.reason}。请在项目配置中补齐凭据或在沙盒注入对应环境变量后重试。`
  };
}
