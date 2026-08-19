import assert from "node:assert/strict";
import { LegacyCommandRejected, parseLegacyCommandString } from "../src/shellArgv.js";

export function testShellArgvSafety() {
  // Simple command splits into executable + args.
  assert.deepEqual(parseLegacyCommandString("npm run dev"), {
    executable: "npm",
    args: ["run", "dev"]
  });

  // Leading environment assignments must remain safe while still supporting
  // the legacy project-process format used by multi-service fixtures.
  assert.deepEqual(parseLegacyCommandString("PORT=3000 NAME=api node server.mjs"), {
    executable: "node",
    args: ["server.mjs"],
    env: { PORT: "3000", NAME: "api" }
  });

  // Whitespace is collapsed; leading/trailing space trimmed.
  assert.deepEqual(parseLegacyCommandString("   npm   run   dev   "), {
    executable: "npm",
    args: ["run", "dev"]
  });

  // Double-quoted argument with spaces stays a single arg.
  assert.deepEqual(parseLegacyCommandString('echo "hello world"'), {
    executable: "echo",
    args: ["hello world"]
  });

  // Single quotes preserve their content verbatim, including characters that
  // would otherwise be operators.
  assert.deepEqual(parseLegacyCommandString("git commit -m 'fix; drop table'"), {
    executable: "git",
    args: ["commit", "-m", "fix; drop table"]
  });

  // Backslash escapes the next character (unquoted), so an escaped space
  // becomes part of the token rather than a separator.
  assert.deepEqual(parseLegacyCommandString("npm run\\ dev"), {
    executable: "npm",
    args: ["run dev"]
  });

  // Empty quoted argument is preserved as an empty-string arg.
  assert.deepEqual(parseLegacyCommandString('echo ""'), {
    executable: "echo",
    args: [""]
  });

  // Empty / whitespace-only input is rejected.
  for (const empty of ["", "   ", "\t"]) {
    assert.throws(() => parseLegacyCommandString(empty), LegacyCommandRejected);
  }

  // Every shell flow / substitution / redirection operator is rejected when
  // unquoted, so the command can never be mis-executed after the shell removed.
  // (An *escaped* operator like `\;` is allowed because under `shell:false` it
  // is a literal argument and cannot change control flow — that is tested
  // implicitly by the backslash-escape cases above.)
  const rejected = [";", "|", "&", "&&", "||", "$VAR", "`id`", ">", "<", "(", ")"];
  for (const input of rejected) {
    assert.throws(
      () => parseLegacyCommandString(`echo ${input}`),
      (err: Error) => err instanceof LegacyCommandRejected,
      `expected rejection for: ${input}`
    );
  }

  // A newline in the middle of a command is a shell separator and is rejected
  // (a trailing newline is harmless whitespace and is trimmed away).
  assert.throws(() => parseLegacyCommandString("echo foo\nbar"), LegacyCommandRejected);
  assert.throws(() => parseLegacyCommandString("echo foo\rbar"), LegacyCommandRejected);

  // An operator inside single quotes is preserved, not rejected.
  assert.deepEqual(parseLegacyCommandString("echo 'a;b'"), {
    executable: "echo",
    args: ["a;b"]
  });

  // Unterminated quotes are rejected.
  assert.throws(() => parseLegacyCommandString('echo "unterminated'), LegacyCommandRejected);
  assert.throws(() => parseLegacyCommandString("echo 'unterminated"), LegacyCommandRejected);

  // A trailing backslash with nothing to escape is rejected.
  assert.throws(() => parseLegacyCommandString("npm run\\"), LegacyCommandRejected);
}
