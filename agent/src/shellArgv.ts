// Safe tokenizer for legacy string commands.
//
// Background: ProjectConfig historically carried free-form command strings
// (startCommand / installCommand / cleanupCommand). Running those through
// `spawn(string, { shell: true })` opens a shell-injection window. This module
// tokenizes a command line into argv the way a POSIX shell splits tokens
// (whitespace splitting with single and double quote handling), but REJECTS
// any unquoted shell metacharacter that would change execution flow or trigger
// substitution / redirection. A rejected command must be migrated to a
// structured CommandSpec instead of being executed through a shell.
//
// Under `shell: false` (the only mode this parser feeds) argv entries are
// passed to execve literally, so the only residual risk is an executable name
// containing path separators; callers still apply the project commandAllowlist.

// Characters that, when unquoted, indicate shell flow control, substitution or
// redirection. Rejecting them (rather than silently dropping) prevents a legacy
// command from being mis-executed after the shell is removed.
const SHELL_OPERATORS = /[|&;<>$`()\n\r\\]/;

export interface ParsedArgv {
  executable: string;
  args: string[];
  /** Leading POSIX-style KEY=value assignments from legacy command strings. */
  env?: Record<string, string>;
}

export class LegacyCommandRejected extends Error {
  constructor(public readonly reason: string) {
    super(`legacy_command_rejected: ${reason}`);
    this.name = "LegacyCommandRejected";
  }
}

/**
 * Parse a legacy command string into a literal argv. Throws
 * LegacyCommandRejected if the string contains unquoted shell operators, an
 * unterminated quote, or is empty. Quoted content is preserved verbatim;
 * backslash escapes only the next character (unquoted) or the small POSIX
 * double-quote escape set.
 */
export function parseLegacyCommandString(input: string): ParsedArgv {
  const trimmed = input.trim();
  if (!trimmed) throw new LegacyCommandRejected("empty_command");

  const argv: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\") {
        const next = trimmed[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    // Unquoted region.
    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (ch === "\\") {
      const next = trimmed[i + 1];
      if (next === undefined) throw new LegacyCommandRejected("trailing_backslash");
      current += next;
      i += 1;
      hasContent = true;
      continue;
    }
    if (SHELL_OPERATORS.test(ch)) {
      throw new LegacyCommandRejected(`shell_operator:${ch}`);
    }
    if (ch === " " || ch === "\t") {
      if (current || hasContent) {
        argv.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += ch;
    hasContent = true;
  }

  if (inSingle || inDouble) throw new LegacyCommandRejected("unterminated_quote");
  if (current || hasContent) argv.push(current);
  if (argv.length === 0) throw new LegacyCommandRejected("empty_command");

  // Legacy project configs commonly use `PORT=3000 npm run dev` or
  // `NAME=api node server.mjs`. With shell execution removed, those tokens
  // must become the child environment rather than being treated as the
  // executable name. Only valid POSIX variable names are accepted here.
  const env: Record<string, string> = {};
  let commandIndex = 0;
  while (commandIndex < argv.length) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[commandIndex]);
    if (!assignment) break;
    env[assignment[1]] = assignment[2];
    commandIndex += 1;
  }
  if (commandIndex >= argv.length) throw new LegacyCommandRejected("missing_executable");

  return {
    executable: argv[commandIndex],
    args: argv.slice(commandIndex + 1),
    ...(Object.keys(env).length ? { env } : {})
  };
}
