import http from "node:http";

const port = Number(process.env.PORT ?? 0);
const orders = [
  { id: "ORD-1001", customer: "Acme", status: "pending", amount: 9800 },
  { id: "ORD-1002", customer: "Globex", status: "approved", amount: 1200 },
  { id: "ORD-1003", customer: "Initech", status: "rejected", amount: 3200 }
];

function send(response, status, value, type = "application/json; charset=utf-8") {
  response.writeHead(status, { "content-type": type });
  response.end(type.startsWith("application/json") ? JSON.stringify(value) : value);
}

function page(response, variant = "") {
  send(response, 200, `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Order Portal Lite</title><style>body{font-family:system-ui;margin:32px;background:#fff8f1;color:#2c2118}main{max-width:820px;margin:auto;background:white;padding:28px;border:1px solid #ead8c6;border-radius:12px}button,input,select{padding:9px;margin:4px}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:10px;border-bottom:1px solid #ead8c6;text-align:left}.notice{min-height:24px;color:#a33}</style></head><body><main>
  <h1>Order Portal Lite</h1><p data-testid="auth-state">signed in qa.orders@example.com</p>
  <section><h2>Orders</h2><label>Status <select id="status"><option value="all">All</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label><button id="load">Load orders</button><table data-testid="order-table"><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Amount</th></tr></thead><tbody id="rows"></tbody></table></section>
  <section><h2>Approval</h2><input id="orderId" aria-label="Order ID" value="${variant === "fxv_d20b8f2d5c3a9074" ? "ORD-1002" : "ORD-1001"}" placeholder="ORD-1001"/><button id="approve">Approve order</button><p class="notice" data-testid="approval-status">pending</p></section>
  <section><h2>Resilience</h2><button id="simulateError">Simulate order API failure</button><button id="retryError">Retry order load</button><p class="notice" data-testid="order-error-state"></p></section>
  <section><h2>Schema</h2><button id="schema">Validate order API schema</button><p data-testid="schema-state">unchecked</p></section>
  <section><h2>Role</h2><select id="role" aria-label="Role"><option value="reviewer">reviewer</option><option value="viewer">viewer</option></select><button id="apply">Apply role</button><p data-testid="permission-status">reviewer: approve pending orders</p></section>
  <script>
    const variant=${JSON.stringify(variant)};const suffix=variant?'&fixtureVariantId='+encodeURIComponent(variant):'';const rows=document.querySelector('#rows');
    async function load(){const s=document.querySelector('#status').value;const r=await fetch('/api/orders?status='+s+suffix);const d=await r.json();if(!r.ok){rows.innerHTML='<tr><td colspan="4">Order API unavailable</td></tr>';return;}rows.innerHTML=d.orders.map(o=>'<tr><td>'+o.id+'</td><td>'+o.customer+'</td><td>'+o.status+'</td><td>'+o.amount+'</td></tr>').join('');}
    document.querySelector('#load').onclick=load;document.querySelector('#status').onchange=load;
    document.querySelector('#approve').onclick=async()=>{const id=document.querySelector('#orderId').value;const r=await fetch('/api/orders/'+id+'/approve?fixtureVariantId='+encodeURIComponent(variant),{method:'POST'});const d=await r.json();document.querySelector('[data-testid=approval-status]').textContent=r.ok?d.order.status:d.error;load();};
    document.querySelector('#simulateError').onclick=async()=>{const r=await fetch('/api/orders?status=error'+suffix);document.querySelector('[data-testid=order-error-state]').textContent=r.ok?'unexpected success':'order API failure';};
    document.querySelector('#retryError').onclick=()=>{document.querySelector('[data-testid=order-error-state]').textContent='recovered';};
    document.querySelector('#schema').onclick=async()=>{const r=await fetch('/openapi.json');const d=await r.json();document.querySelector('[data-testid=schema-state]').textContent=d.paths['/api/orders/{id}/approve']?'schema ok':'schema missing';};
    const permissionBypass=${variant === "fxv_d30c9a3e6d4b0185" || variant === "fxv_5e1f8b26c4a907d3"};document.querySelector('#apply').onclick=()=>{const role=document.querySelector('#role').value;document.querySelector('[data-testid=permission-status]').textContent=role==='viewer'&&!permissionBypass?'viewer: read-only':'reviewer: approve pending orders';};load();
  </script></main></body></html>`, "text/html; charset=utf-8");
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") return send(response, 200, { ok: true, service: "order-portal-lite" });
  if (url.pathname === "/openapi.json") return send(response, 200, { openapi: "3.0.0", info: { title: "Order Portal Lite", version: "0.1.0" }, paths: { "/api/orders": { get: {} }, "/api/orders/{id}/approve": { post: {} } } });
  if (url.pathname === "/api/orders" && request.method === "GET") {
    const status = url.searchParams.get("status");
    if (status === "error") return send(response, 503, { ok: false, error: "order_api_failure" });
    return send(response, 200, { ok: true, orders: orders.filter((order) => !status || status === "all" || order.status === status) });
  }
  const approval = url.pathname.match(/^\/api\/orders\/([^/]+)\/approve$/);
  if (approval && request.method === "POST") {
    const order = orders.find((item) => item.id === approval[1]);
    if (!order) return send(response, 404, { error: "order not found" });
    if (order.status !== "pending") return send(response, 409, { error: "only pending orders can be approved" });
    const status = url.searchParams.get("fixtureVariantId") === "fxv_7f3a1c92d6e8405b" ? "pending" : "approved";
    return send(response, 200, { ok: true, order: { ...order, status } });
  }
  return page(response, url.searchParams.get("fixtureVariantId") ?? "");
});
server.listen(port, process.env.HOST ?? "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
