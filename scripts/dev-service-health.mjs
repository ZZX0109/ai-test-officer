import net from "node:net";

const configured = (name, fallback) => Number(process.env[name] ?? fallback);
const ports = {
  agent: configured("PORT", 4317),
  appApi: configured("APP_API_PORT", 6172),
  appWeb: configured("APP_WEB_PORT", 6173),
  workbench: configured("WORKBENCH_PORT", 6174)
};
const services = [
  { id: "agent", port: ports.agent, url: process.env.AGENT_HEALTH_URL ?? `http://127.0.0.1:${ports.agent}/api/health` },
  { id: "appApi", port: ports.appApi, url: process.env.APP_API_HEALTH_URL ?? `http://127.0.0.1:${ports.appApi}/api/health` },
  { id: "appWeb", port: ports.appWeb, url: process.env.APP_URL ?? `http://127.0.0.1:${ports.appWeb}` },
  { id: "workbench", port: ports.workbench, url: process.env.WORKBENCH_URL ?? `http://127.0.0.1:${ports.workbench}` }
];

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(700);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function checkService(service) {
  const listening = await isListening(service.port);
  if (!listening) {
    return { id: service.id, port: service.port, status: "missing", listening: false };
  }
  try {
    const response = await fetch(service.url, { signal: AbortSignal.timeout(1500) });
    return {
      id: service.id,
      port: service.port,
      status: response.ok ? "listening" : "unhealthy",
      listening: true,
      httpStatus: response.status,
      url: service.url
    };
  } catch (error) {
    return {
      id: service.id,
      port: service.port,
      status: "unhealthy",
      listening: true,
      url: service.url,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

const checks = await Promise.all(services.map(checkService));
const result = {
  ok: checks.every((item) => item.status === "listening"),
  checkedAt: new Date().toISOString(),
  services: Object.fromEntries(checks.map((item) => [item.id, item]))
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
