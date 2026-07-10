import net from "node:net";

const services = [
  { id: "agent", port: 4317, url: "http://127.0.0.1:4317/api/health" },
  { id: "appApi", port: 6172, url: "http://127.0.0.1:6172/api/health" },
  { id: "appWeb", port: 6173, url: "http://127.0.0.1:6173" },
  { id: "workbench", port: 6174, url: "http://127.0.0.1:6174" }
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
