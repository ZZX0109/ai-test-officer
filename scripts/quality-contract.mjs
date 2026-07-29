import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const sourceRoots = [
  "agent/src",
  "packages/contracts/src",
  "packages/playwright-runtime/src",
  "packages/desktop-runtime/src",
  "packages/execution-worker/src",
  "packages/agent-orchestration/src",
  "workbench-ui/src",
  "app-under-test/src"
];

async function sourceFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !relative.includes(`${path.sep}generated${path.sep}`)
      ? [relative]
      : [];
  }));
  return nested.flat();
}

const files = (await Promise.all(sourceRoots.map(sourceFiles))).flat();
const violations = [];

for (const relative of files) {
  const text = await readFile(path.join(root, relative), "utf8");
  if (/\bz\.any\s*\(/.test(text)) violations.push(`${relative}: z.any() is forbidden; use a concrete schema or z.unknown() plus narrowing`);
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, relative.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${relative}:${position.line + 1}:${position.character + 1}: explicit any is forbidden`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`quality contract passed (${files.length} source files; no z.any() or explicit any)`);
}
