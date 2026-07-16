import http from "node:http";

const port = Number(process.env.PORT ?? 0);
const tasks = [
  { id: 1, title: "Prepare release notes", status: "active", owner: "qa" },
  { id: 2, title: "Verify payment callback", status: "completed", owner: "backend" },
  { id: 3, title: "Review accessibility report", status: "active", owner: "frontend" }
];

function send(response, status, value, type = "application/json; charset=utf-8") {
  response.writeHead(status, { "content-type": type });
  response.end(type.startsWith("application/json") ? JSON.stringify(value) : value);
}

function page(response, variant = "") {
  send(response, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Todo Lite</title><style>
  body{font-family:system-ui;margin:32px;background:#f5f7fb;color:#172033}main{max-width:760px;margin:auto;background:white;padding:28px;border-radius:12px;box-shadow:0 8px 30px #17203318}button,input,select{padding:9px;margin:4px}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:10px;border-bottom:1px solid #e7eaf0;text-align:left}.toolbar{display:flex;gap:8px;flex-wrap:wrap}.error{color:#b42318}
  </style></head><body><main><h1>Todo Lite</h1><p data-testid="auth-state">signed in qa.todo@example.com</p>
  <section><h2>Authentication</h2><button id="signout">Sign out</button><button id="signin">Sign in test user</button><p data-testid="permission-state"></p></section>
  <section><h2>Tasks</h2><div class="toolbar"><label>Status <select id="status"><option value="all">All</option><option value="active">Active</option><option value="completed">Completed</option></select></label><label>Search <input id="keyword" aria-label="${variant === "fxv_9c4d0a73e1b625f8" ? "Find work items" : "Search tasks"}"/></label><button id="refresh">Refresh</button></div><table data-testid="task-table"><thead><tr><th>Title</th><th>Status</th><th>Owner</th></tr></thead><tbody id="rows"></tbody></table></section>
  <section><h2>Create task</h2><label>Title <input id="title" aria-label="Task title"/></label><button id="create">Create</button><p data-testid="form-error" class="error"></p></section>
  <section><h2>Permissions</h2><select id="role" aria-label="Role"><option value="editor">editor</option><option value="viewer">viewer</option></select><button id="apply-role">Apply role</button><p data-testid="permission-status">editor: create and update</p></section>
  <script>
  const variant=${JSON.stringify(variant)};const rows=document.querySelector('#rows');const status=document.querySelector('#status');const keyword=document.querySelector('#keyword');const permissionBypass=${variant === "fxv_d10a7e1c4b298f63"};let authenticated=true;
  async function load(){if(!authenticated&&!permissionBypass){rows.innerHTML='<tr><td colspan="3">Login required</td></tr>';return;}const q=new URLSearchParams();if(status.value!=='all')q.set('status',status.value);if(keyword.value.trim())q.set('keyword',keyword.value.trim());if(variant)q.set('fixtureVariantId',variant);const r=await fetch('/api/tasks?'+q);const data=await r.json();if(!r.ok){rows.innerHTML='<tr><td colspan="3">API unavailable</td></tr>';return;}rows.innerHTML=data.tasks.map(t=>'<tr><td>'+t.title+'</td><td>'+t.status+'</td><td>'+t.owner+'</td></tr>').join('')||'<tr><td colspan="3">No tasks</td></tr>';}
  document.querySelector('#refresh').onclick=load;status.onchange=load;document.querySelector('#create').onclick=async()=>{const title=document.querySelector('#title').value.trim();const r=await fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title})});const data=await r.json();document.querySelector('[data-testid=form-error]').textContent=r.ok?'created':data.error;load();};
  document.querySelector('#apply-role').onclick=()=>{const role=document.querySelector('#role').value;document.querySelector('[data-testid=permission-status]').textContent=role==='viewer'?'viewer: read-only':'editor: create and update';};document.querySelector('#signout').onclick=()=>{authenticated=false;document.querySelector('[data-testid=auth-state]').textContent='signed out';document.querySelector('[data-testid=permission-state]').textContent=permissionBypass?'session missing':'login required';load();};document.querySelector('#signin').onclick=()=>{authenticated=true;document.querySelector('[data-testid=auth-state]').textContent='signed in qa.todo@example.com';document.querySelector('[data-testid=permission-state]').textContent='';load();};load();
  </script></main></body></html>`, "text/html; charset=utf-8");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") return send(response, 200, { ok: true, service: "todo-lite" });
  if (url.pathname === "/openapi.json") return send(response, 200, { openapi: "3.0.0", info: { title: "Todo Lite", version: "0.1.0" }, paths: { "/api/tasks": { get: {}, post: {} } } });
  if (url.pathname === "/api/tasks" && request.method === "GET") {
    if (url.searchParams.get("fixtureVariantId") === "fxv_2b8e6d41a9c753f0") return send(response, 503, { error: "fixture outage" });
    const status = url.searchParams.get("status"); const keyword = (url.searchParams.get("keyword") ?? "").toLowerCase();
    return send(response, 200, { ok: true, tasks: tasks.filter((task) => (!status || status === "all" || task.status === status) && (!keyword || task.title.toLowerCase().includes(keyword))) });
  }
  if (url.pathname === "/api/tasks" && request.method === "POST") {
    let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { const input = JSON.parse(body || "{}"); if (!input.title?.trim()) return send(response, 400, { error: "title is required" }); tasks.push({ id: Date.now(), title: input.title.trim(), status: "active", owner: "qa" }); send(response, 201, { ok: true }); }); return;
  }
  return page(response, url.searchParams.get("fixtureVariantId") ?? "");
});
server.listen(port, process.env.HOST ?? "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
