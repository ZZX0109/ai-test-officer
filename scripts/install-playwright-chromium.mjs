import { spawn } from "node:child_process";

const attempts = Number(process.env.PLAYWRIGHT_INSTALL_ATTEMPTS ?? 3);
const retryDelayMs = Number(process.env.PLAYWRIGHT_INSTALL_RETRY_DELAY_MS ?? 3_000);

function run() {
  return new Promise((resolve) => {
    const child = spawn("npx", ["playwright", "install", "--with-deps", "chromium"], {
      stdio: "inherit",
      env: process.env
    });
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

let lastExitCode = 1;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  console.log(`Installing Playwright Chromium (attempt ${attempt}/${attempts})`);
  lastExitCode = await run();
  if (lastExitCode === 0) process.exit(0);
  if (attempt < attempts) {
    console.error(`Playwright Chromium installation failed with exit ${lastExitCode}; retrying in ${retryDelayMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

process.exitCode = lastExitCode;
