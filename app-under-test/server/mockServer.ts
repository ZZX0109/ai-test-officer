import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type TaskStatus = "active" | "completed";

interface Task {
  id: number;
  title: string;
  status: TaskStatus;
}

const host = process.env.APP_API_HOST ?? "127.0.0.1";
const port = Number(process.env.APP_API_PORT ?? 6172);
const allowedOrigins = new Set(
  (process.env.APP_ALLOWED_ORIGINS ?? "http://localhost:6173,http://127.0.0.1:6173")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);

const seedTasks: Task[] = [
  { id: 1, title: "准备答辩材料", status: "active" },
  { id: 2, title: "修复筛选逻辑", status: "active" },
  { id: 3, title: "提交测试报告", status: "completed" },
  { id: 4, title: "urgent 发布巡检", status: "active" }
];

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function applyCors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (typeof origin === "string" && allowedOrigins.has(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function listTasks(url: URL) {
  const status = url.searchParams.get("status") ?? "all";
  const keyword = (url.searchParams.get("keyword") ?? "").trim().toLowerCase();
  if (status === "error") {
    return { statusCode: 503, body: { error: "模拟接口失败" } };
  }
  const byStatus = status === "all" ? seedTasks : seedTasks.filter((task) => task.status === status);
  const byKeyword = keyword
    ? byStatus.filter((task) => task.title.toLowerCase().includes(keyword))
    : byStatus;
  return { statusCode: 200, body: { tasks: byKeyword } };
}

const server = createServer((req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, service: "app-under-test-api" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/tasks") {
    const result = listTasks(url);
    sendJson(res, result.statusCode, result.body);
    return;
  }
  sendJson(res, 404, { error: "Not found" });
});

server.listen(port, host, () => {
  console.log(`App Under Test API listening on http://${host}:${port}`);
});
