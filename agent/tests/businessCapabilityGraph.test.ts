import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBusinessCapabilityGraph, readBusinessSourceSlices } from "../src/businessCapabilityGraph.js";
import { compileBusinessPaths } from "../src/businessPathCompiler.js";
import { buildCodeImpactGraph } from "../src/codeImpactGraph.js";

export async function testBusinessCapabilityGraph() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ato-business-capability-"));
  try {
    await mkdir(path.join(root, "src", "pages"), { recursive: true });
    await mkdir(path.join(root, "server"), { recursive: true });
    await mkdir(path.join(root, "api"), { recursive: true });
    await writeFile(path.join(root, "src", "pages", "Orders.tsx"), `
      export function OrdersPage() {
        const approve = () => fetch('/api/orders/42/approve');
        return <button onClick={approve}>Approve</button>;
      }
    `);
    await writeFile(path.join(root, "src", "pages", "Reports.vue"), `<template><button @click="loadReports">Load</button></template><script setup>const loadReports = () => fetch('/api/reports')</script>`);
    await writeFile(path.join(root, "server", "orders.ts"), `
      app.post('/api/orders/:id/approve', requireAuth, approveOrder);
      async function approveOrder() { await queue.add('approval'); }
      const queue = new Queue('orders');
    `);
    await writeFile(path.join(root, "api", "reports.py"), "@app.get('/api/reports')\ndef reports():\n    return {'ok': True}\n");
    await mkdir(path.join(root, "go"), { recursive: true });
    await writeFile(path.join(root, "go", "main.go"), "package main\nimport \"net/http\"\nfunc main() {\n  mux := http.NewServeMux()\n  mux.HandleFunc(\"/api/go/health\", health)\n  r := gin.Default()\n  r.GET(\"/api/go/users\", listUsers)\n  r.POST(\"/api/go/users\", createUser)\n}\n");
    await mkdir(path.join(root, "rust"), { recursive: true });
    await writeFile(path.join(root, "rust", "main.rs"), "use axum::{Router, routing::get};\nasync fn root() {}\nlet app = Router::new().route(\"/api/rust/health\", get(root)).route(\"/api/rust/items\", post(create));\n");
    await mkdir(path.join(root, "java"), { recursive: true });
    await writeFile(path.join(root, "java", "OrdersController.java"), "@RestController\n@RequestMapping(\"/api/java\")\npublic class OrdersController {\n  @GetMapping(\"/orders\")\n  public List<Order> list() {}\n  @PostMapping(\"/orders\")\n  public Order create() {}\n}\n");
    await mkdir(path.join(root, "ruby"), { recursive: true });
    await writeFile(path.join(root, "ruby", "routes.rb"), "Rails.application.routes.draw do\n  get \"/api/ruby/orders\" => \"orders#index\"\n  post \"/api/ruby/orders\" => \"orders#create\"\n  resources :products\nend\n");
    await mkdir(path.join(root, "php"), { recursive: true });
    await writeFile(path.join(root, "php", "index.php"), "<?php\n$app = new \\Slim\\App();\n$app->get('/api/php/health', 'health');\n$app->post('/api/php/orders', 'create');\nRoute::get('/api/php/products', 'ProductController@index');\n");
    await writeFile(path.join(root, ".env"), "SECRET_SHOULD_NOT_BE_INDEXED=never");
    const codeGraph = await buildCodeImpactGraph({
      repositoryRoot: root,
      files: [],
      includeRepositorySources: true
    });
    const graph = await buildBusinessCapabilityGraph({ repositoryRoot: root, codeGraph });
    assert.equal(graph.version, "2.0");
    assert.ok(graph.nodes.some((node) => node.kind === "page" && /Orders|Reports/i.test(node.label)));
    assert.ok(graph.nodes.some((node) => node.kind === "ui-action" && /approve|loadReports/i.test(node.label)));
    assert.ok(graph.nodes.some((node) => node.kind === "frontend-call" && node.metadata?.route === "/api/reports"));
    assert.ok(graph.nodes.some((node) => node.kind === "api-route" && /\/api\/orders\/:param|\/api\/reports/.test(node.metadata?.route ?? node.label)));
    assert.ok(graph.nodes.some((node) => node.kind === "auth-guard"));
    assert.ok(graph.nodes.some((node) => node.kind === "background-task"));
    assert.ok(!graph.nodes.some((node) => node.source?.file === ".env"));
    assert.ok(graph.edges.some((edge) => edge.kind === "calls" && edge.confidence === "high"));
    assert.ok(graph.nodes.some((node) => node.source?.parser === "next-ast"), "React/Next files must use the TypeScript AST adapter");
    assert.ok(graph.nodes.some((node) => node.source?.parser === "vue-ast"), "Vue SFC files must use the SFC adapter");
    assert.ok(graph.nodes.some((node) => node.source?.parser === "fastapi-python-ast"), "FastAPI files must use Python ast, not source regexes");

    assert.ok(graph.nodes.some((node) => node.kind === "api-route" && node.metadata?.framework === "go-http" && node.metadata?.route === "/api/go/users"), "Go handlers must surface as api-route nodes");
    assert.ok(graph.nodes.some((node) => node.kind === "api-route" && node.metadata?.framework === "axum" && node.metadata?.route === "/api/rust/health"), "Rust axum routes must surface as api-route nodes");
    assert.ok(graph.nodes.some((node) => node.kind === "api-route" && node.metadata?.framework === "spring" && node.metadata?.route === "/api/java/orders"), "Java Spring mappings must surface as api-route nodes");
    assert.ok(graph.nodes.some((node) => node.kind === "api-route" && node.metadata?.framework === "rails" && node.metadata?.route === "/products"), "Rails resources must surface as api-route nodes");
    assert.ok(graph.nodes.some((node) => node.kind === "api-route" && node.metadata?.framework === "laravel" && node.metadata?.route === "/api/php/products"), "Laravel routes must surface as api-route nodes");
    assert.ok(graph.nodes.some((node) => node.source?.parser === "go-ast-grep"), "Go files must use the Go AST adapter");
    assert.ok(graph.nodes.some((node) => node.source?.parser === "rust-ast-grep"), "Rust files must use the Rust AST adapter");
    assert.ok(graph.nodes.some((node) => node.source?.parser === "java-ast-grep"), "Java files must use the Java AST adapter");
    assert.ok(graph.nodes.some((node) => node.source?.parser === "ruby-ast-grep"), "Ruby files must use the Ruby AST adapter");
    assert.ok(graph.nodes.some((node) => node.source?.parser === "php-ast-grep"), "PHP files must use the PHP AST adapter");

    const paths = compileBusinessPaths({ graph, goal: "测试订单审批", comprehensive: true, browserEnabled: true });
    assert.ok(paths.length >= 2);
    assert.ok(paths.some((item) => item.surfaces.includes("page") && item.sourceLocations.some((location) => location.file.endsWith("Orders.tsx"))));
    assert.ok(paths.every((item) => item.sourceNodeIds.length > 0));
    const targeted = compileBusinessPaths({ graph, goal: "审批订单", comprehensive: false, browserEnabled: true });
    assert.ok(targeted.length > 0);
    const source = await readBusinessSourceSlices({ repositoryRoot: root, locations: targeted.flatMap((item) => item.sourceLocations) });
    assert.ok(source.length > 0);
    assert.ok(source.every((item) => !item.file.includes(".env")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
