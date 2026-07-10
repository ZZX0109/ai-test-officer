export async function checkEnvironment(appUrl: string) {
  const startedAt = Date.now();
  try {
    const response = await fetch(appUrl, { signal: AbortSignal.timeout(5000) });
    return {
      ok: response.ok,
      appUrl,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      checks: [
        { name: "app_url_reachable", passed: response.ok, detail: `HTTP ${response.status}` },
        { name: "agent_runtime", passed: true, detail: `Node ${process.version}` }
      ]
    };
  } catch (error) {
    return {
      ok: false,
      appUrl,
      status: 0,
      latencyMs: Date.now() - startedAt,
      checks: [
        { name: "app_url_reachable", passed: false, detail: error instanceof Error ? error.message : "unknown error" },
        { name: "agent_runtime", passed: true, detail: `Node ${process.version}` }
      ]
    };
  }
}

