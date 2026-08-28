import { spawn } from "node:child_process";

export interface CapturedProcessOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Capture bounded output from a trusted host-side helper such as git or the
 * container engine. Project commands use the managed process path instead. */
export async function captureProcessOutput(
  executable: string,
  args: string[],
  timeoutMs = 5_000,
  maxBytes = 512 * 1024
): Promise<CapturedProcessOutput> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: unknown) => `${current}${String(chunk)}`.slice(-maxBytes);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exitCode: null, stdout, stderr });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}
