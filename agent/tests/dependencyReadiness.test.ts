import assert from "node:assert/strict";
import { detectPrivateDependencyBlocker } from "../src/dependencyReadiness.js";

function ctxWith(files: Record<string, string | undefined>) {
  return {
    readProjectFile: async (relativePath: string) => files[relativePath]
  };
}

export async function testPrivateDependencyBlockerDetectsNpmPrivateRegistryWithoutToken() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    ".npmrc": "@myco:registry=https://npm.myco.internal/\n"
  }));
  assert.ok(finding?.blocked, "private registry without token must block");
  assert.equal(finding?.stack, "node");
  assert.match(finding?.reason ?? "", /npm 私有 registry https:\/\/npm\.myco\.internal/);
  assert.match(finding?.reason ?? "", /_authToken/);
}

export async function testPrivateDependencyBlockerPassesNpmPrivateRegistryWithToken() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    ".npmrc": [
      "@myco:registry=https://npm.myco.internal/",
      "//npm.myco.internal/:_authToken=secret-token"
    ].join("\n")
  }));
  assert.equal(finding, undefined, "private registry with a scoped token must not block");
}

export async function testPrivateDependencyBlockerIgnoresPublicNpmRegistry() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    ".npmrc": "registry=https://registry.npmjs.org/\n"
  }));
  assert.equal(finding, undefined, "the public npm registry must not block");
}

export async function testPrivateDependencyBlockerDetectsPipPrivateIndex() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    "requirements.txt": "--extra-index-url https://pypi.myco.internal/simple\nfastapi==0.110\n"
  }));
  assert.ok(finding?.blocked, "a private pip index must block");
  assert.equal(finding?.stack, "python");
  assert.match(finding?.reason ?? "", /pip 私有 index https:\/\/pypi\.myco\.internal/);
}

export async function testPrivateDependencyBlockerDetectsPipGitSshDependency() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    "requirements.txt": "internal-pkg @ git+ssh://git@github.com:myco/internal-pkg.git\n"
  }));
  assert.ok(finding?.blocked, "a git+ssh pip dependency must block (no SSH key in sandbox)");
  assert.match(finding?.reason ?? "", /git\+ssh/);
}

export async function testPrivateDependencyBlockerPassesPublicPipRequirements() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    "requirements.txt": "fastapi==0.110\nuvicorn==0.29\n--index-url https://pypi.org/simple\n"
  }));
  assert.equal(finding, undefined, "public-only pip deps must not block");
}

export async function testPrivateDependencyBlockerPassesWhenNoDepConfig() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({}));
  assert.equal(finding, undefined, "a project with no private-dep config must not block");
}

export async function testPrivateDependencyBlockerDetectsGoPrivateGitReplace() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    "go.mod": "module example\n\ngo 1.22\n\nrequire github.com/x/y v1.0.0\n\nreplace github.com/x/y => git@gitlab.private:team/y.git\n"
  }));
  assert.equal(finding?.blocked, true, "go.mod replace to git@ must block");
  assert.equal(finding?.stack, "go");
}

export async function testPrivateDependencyBlockerDetectsCargoPrivateGitDep() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    "Cargo.toml": "[package]\nname = \"x\"\n[dependencies]\npriv = { git = \"ssh://git@github.com/private/priv.git\" }\n"
  }));
  assert.equal(finding?.blocked, true, "Cargo.toml git ssh dep must block");
  assert.equal(finding?.stack, "rust");
}

export async function testPrivateDependencyBlockerDetectsMavenPrivateRepo() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    "pom.xml": "<project><repositories><repository><id>corp</id><url>https://nexus.corp.internal/maven</url></repository></repositories></project>"
  }));
  assert.equal(finding?.blocked, true, "pom.xml private repo must block");
  assert.equal(finding?.stack, "java");
}

export async function testPrivateDependencyBlockerDetectsBundlerPrivateGit() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    "Gemfile": 'source "https://rubygems.org"\ngem "priv", git: "git@github.com:private/priv.git"'
  }));
  assert.equal(finding?.blocked, true, "Gemfile git@ dep must block");
  assert.equal(finding?.stack, "ruby");
}

export async function testPrivateDependencyBlockerDetectsComposerPrivateRepo() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    "composer.json": '{ "repositories": [ { "type": "vcs", "url": "https://git.corp.internal/pkg" } ] }'
  }));
  assert.equal(finding?.blocked, true, "composer.json private repository must block");
  assert.equal(finding?.stack, "php");
}

export async function testPrivateDependencyBlockerPassesPublicMavenCentral() {
  const finding = await detectPrivateDependencyBlocker(ctxWith({
    "pom.xml": "<project><repositories><repository><url>https://repo.maven.apache.org/maven2</url></repository></repositories></project>"
  }));
  assert.equal(finding, undefined, "Maven Central repo must not block");
}
