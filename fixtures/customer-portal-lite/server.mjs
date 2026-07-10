import http from "node:http";

const port = Number(process.env.PORT ?? 0);

function json(response, value) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function html(response) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Customer Portal Lite</title>
    <style>
      body { font-family: ui-sans-serif, system-ui; margin: 32px; color: #17211b; background: #f7f3ea; }
      section { margin: 20px 0; padding: 16px; border: 1px solid #d8cdb9; border-radius: 12px; background: #fffaf0; }
      button, input, select { margin: 4px; padding: 8px 10px; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      td, th { border-bottom: 1px solid #e3d8c7; padding: 8px; text-align: left; }
    </style>
  </head>
  <body>
    <h1>Customer Portal Lite</h1>
    <p data-testid="login-state">signed in qa.customer@example.com</p>

    <section>
      <h2>Customers</h2>
      <button type="button" id="sort">按金额排序</button>
      <label>客户筛选 <input id="filter" aria-label="客户筛选" /></label>
      <button type="button" id="filterButton">筛选客户</button>
      <button type="button" id="next">下一页</button>
      <table data-testid="customer-table">
        <tbody id="customers"><tr><td>Globex Expansion</td><td>1200</td></tr></tbody>
      </table>
    </section>

    <section>
      <h2>Order Form</h2>
      <label>客户名称 <input id="customerName" aria-label="客户名称" /></label>
      <label>订单金额 <input id="orderAmount" aria-label="订单金额" /></label>
      <button type="button" id="submitOrder">提交订单</button>
      <p data-testid="form-error"></p>
    </section>

    <section>
      <h2>Upload</h2>
      <label>上传附件 <input id="upload" aria-label="上传附件" type="file" /></label>
      <button type="button" id="confirmUpload">确认上传</button>
      <p data-testid="upload-state">no file</p>
    </section>

    <section>
      <h2>Approval</h2>
      <button type="button" id="approve">批准请求</button>
      <p data-testid="approval-status">pending</p>
    </section>

    <section>
      <h2>Schema</h2>
      <button type="button" id="schema">校验接口 Schema</button>
      <p data-testid="schema-state">unchecked</p>
    </section>

    <section>
      <h2>Roles</h2>
      <label>切换角色
        <select id="role" aria-label="切换角色">
          <option value="admin">admin</option>
          <option value="viewer">viewer</option>
        </select>
      </label>
      <button type="button" id="applyRole">应用角色</button>
      <p data-testid="permission-matrix">admin: full-access</p>
    </section>

    <script>
      const customers = document.querySelector("#customers");
      document.querySelector("#sort").addEventListener("click", () => {
        customers.innerHTML = "<tr><td>Acme Renewal</td><td>9800</td></tr><tr><td>Globex Expansion</td><td>1200</td></tr>";
      });
      document.querySelector("#filterButton").addEventListener("click", async () => {
        const value = document.querySelector("#filter").value;
        await fetch("/api/customers?query=" + encodeURIComponent(value));
        customers.innerHTML = "<tr><td>Acme Renewal</td><td>9800</td></tr>";
      });
      document.querySelector("#next").addEventListener("click", () => {
        customers.innerHTML += "<tr><td>Acme Renewal Page 2</td><td>1000</td></tr>";
      });
      document.querySelector("#submitOrder").addEventListener("click", () => {
        const name = document.querySelector("#customerName").value;
        const amount = document.querySelector("#orderAmount").value;
        document.querySelector("[data-testid='form-error']").textContent = name && amount ? "order accepted" : "请填写客户名称和订单金额";
      });
      document.querySelector("#confirmUpload").addEventListener("click", () => {
        const file = document.querySelector("#upload").files[0];
        document.querySelector("[data-testid='upload-state']").textContent = file ? file.name : "no file";
      });
      document.querySelector("#approve").addEventListener("click", () => {
        document.querySelector("[data-testid='approval-status']").textContent = "approved";
      });
      document.querySelector("#schema").addEventListener("click", async () => {
        await fetch("/api/schema-check?contract=customer");
        document.querySelector("[data-testid='schema-state']").textContent = "schema ok";
      });
      document.querySelector("#applyRole").addEventListener("click", () => {
        const role = document.querySelector("#role").value;
        document.querySelector("[data-testid='permission-matrix']").textContent = role === "viewer" ? "viewer: read-only" : "admin: full-access";
      });
    </script>
  </body>
</html>`);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") return json(response, { ok: true, service: "customer-portal-lite" });
  if (url.pathname === "/api/customers") return json(response, { ok: true, query: url.searchParams.get("query"), items: ["Acme Renewal"] });
  if (url.pathname === "/api/schema-check") return json(response, { ok: true, contract: url.searchParams.get("contract") });
  return html(response);
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
