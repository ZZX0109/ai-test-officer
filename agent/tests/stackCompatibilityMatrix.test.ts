import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectProject } from "../src/projectDetection.js";

type StackFixture = {
  id: string;
  files: Record<string, string>;
  stack: string[];
  install: string;
  start: string;
  port: number;
  image: string;
  allowlist: string[];
};

async function createFixture(id: string, files: Record<string, string>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `ai-test-officer-stack-${id}-`));
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const filePath = path.join(directory, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }));
  return directory;
}

const fixtures: StackFixture[] = [
  {
    id: "node-vite",
    files: {
      "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^7.0.0", react: "^19.0.0" } }),
      "package-lock.json": "{}"
    },
    stack: ["node", "react", "vite"],
    install: "npm ci",
    start: "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort",
    port: 5173,
    image: "node:22-bookworm-slim",
    allowlist: ["npm", "npx", "node", "pnpm", "yarn", "python", "python3", "pip", "uv", "uvicorn"]
  },
  {
    id: "node-express",
    files: {
      "package.json": JSON.stringify({ scripts: { dev: "node server.mjs" }, dependencies: { express: "^5.0.0" } })
    },
    stack: ["node", "express"],
    install: "npm install",
    start: "npm run dev",
    port: 3000,
    image: "node:22-bookworm-slim",
    allowlist: ["npm", "npx", "node", "pnpm", "yarn", "python", "python3", "pip", "uv", "uvicorn"]
  },
  {
    id: "python-fastapi",
    files: { "requirements.txt": "fastapi==0.115.0\nuvicorn==0.30.0\n", "app.py": "from fastapi import FastAPI\napp = FastAPI()\n" },
    stack: ["python", "fastapi"],
    install: "pip install -r requirements.txt",
    start: "python -m uvicorn app:app --host 0.0.0.0 --port 8000",
    port: 8000,
    image: "python:3.12-slim-bookworm",
    allowlist: ["python", "python3", "pip", "uv", "uvicorn"]
  },
  {
    id: "python-django",
    files: { "requirements.txt": "Django==5.1.0\n", "manage.py": "#!/usr/bin/env python\n" },
    stack: ["python", "django"],
    install: "pip install -r requirements.txt",
    start: "python manage.py runserver 0.0.0.0:8000",
    port: 8000,
    image: "python:3.12-slim-bookworm",
    allowlist: ["python", "python3", "pip", "uv"]
  },
  {
    id: "python-flask",
    files: { "requirements.txt": "Flask==3.0.0\n", "main.py": "from flask import Flask\napp = Flask(__name__)\n" },
    stack: ["python", "flask"],
    install: "pip install -r requirements.txt",
    start: "python -m flask --app main run --host 0.0.0.0 --port 5000",
    port: 5000,
    image: "python:3.12-slim-bookworm",
    allowlist: ["python", "python3", "pip", "uv"]
  },
  {
    id: "python-streamlit",
    files: { "requirements.txt": "streamlit==1.38.0\n", "app.py": "import streamlit as st\nst.title('Stack fixture')\n" },
    stack: ["python", "streamlit"],
    install: "pip install -r requirements.txt",
    start: "python -m streamlit run app.py --server.address 0.0.0.0 --server.port 8501",
    port: 8501,
    image: "python:3.12-slim-bookworm",
    allowlist: ["python", "python3", "pip", "uv"]
  },
  {
    id: "python-gradio",
    files: { "requirements.txt": "gradio==5.0.0\n", "app.py": "import gradio as gr\n" },
    stack: ["python", "gradio"],
    install: "pip install -r requirements.txt",
    start: "python app.py",
    port: 7860,
    image: "python:3.12-slim-bookworm",
    allowlist: ["python", "python3", "pip", "uv"]
  },
  {
    id: "go",
    files: { "go.mod": "module example.test/stack\n\ngo 1.23\n", "main.go": "package main\nfunc main() {}\n" },
    stack: ["go"],
    install: "",
    start: "go run .",
    port: 8080,
    image: "golang:1.23-bookworm",
    allowlist: ["go"]
  },
  {
    id: "rust",
    files: { "Cargo.toml": "[package]\nname = 'stack-fixture'\nversion = '0.1.0'\nedition = '2021'\n", "src/main.rs": "fn main() {}\n" },
    stack: ["rust"],
    install: "",
    start: "cargo run",
    port: 8080,
    image: "rust:1.84-bookworm",
    allowlist: ["cargo"]
  },
  {
    id: "java-maven-spring",
    files: { "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>" },
    stack: ["java", "spring"],
    install: "",
    start: "mvn spring-boot:run",
    port: 8080,
    image: "maven:3.9-eclipse-temurin-21",
    allowlist: ["mvn", "./mvnw", "java"]
  },
  {
    id: "java-gradle-spring",
    files: { "build.gradle": "plugins { id 'org.springframework.boot' version '3.3.0' }\n" },
    stack: ["java", "spring"],
    install: "",
    start: "gradle bootRun",
    port: 8080,
    image: "gradle:8.12-jdk21",
    allowlist: ["gradle", "./gradlew", "java"]
  },
  {
    id: "ruby-rails",
    files: { "Gemfile": "source 'https://rubygems.org'\ngem 'rails'\n", "config.ru": "run ->(_) { [200, {}, ['ok']] }\n" },
    stack: ["ruby", "rails"],
    install: "bundle install",
    start: "bundle exec rails server -b 0.0.0.0 -p 3000",
    port: 3000,
    image: "ruby:3.3-bookworm",
    allowlist: ["bundle", "ruby"]
  },
  {
    id: "php-laravel",
    files: { "composer.json": "{\"require\": {\"laravel/framework\": \"^11.0\"}}", "artisan": "#!/usr/bin/env php\n" },
    stack: ["php", "laravel"],
    install: "composer install",
    start: "php artisan serve --host 0.0.0.0 --port 8000",
    port: 8000,
    image: "composer:2",
    allowlist: ["php", "composer"]
  },
  {
    id: "static",
    files: { "index.html": "<!doctype html><title>Stack fixture</title>" },
    stack: ["static"],
    install: "",
    start: "python3 -m http.server 4173 --bind 0.0.0.0",
    port: 4173,
    image: "python:3.12-slim-bookworm",
    allowlist: ["python3"]
  }
];

export async function testStackCompatibilityMatrix() {
  const directories: string[] = [];
  try {
    for (const fixture of fixtures) {
      const directory = await createFixture(fixture.id, fixture.files);
      directories.push(directory);
      const result = await detectProject(directory);
      const config = result.suggestedConfig;

      assert.equal(result.exists, true, `${fixture.id}: project directory must exist`);
      for (const stack of fixture.stack) assert.ok(result.detectedStack.includes(stack as never), `${fixture.id}: must identify ${stack}`);
      assert.equal(config.installCommand, fixture.install, `${fixture.id}: install command`);
      assert.equal(config.processes?.[0]?.command, fixture.start, `${fixture.id}: start command`);
      assert.equal(config.frontendUrl, `http://127.0.0.1:${fixture.port}`, `${fixture.id}: runtime URL`);
      assert.equal(config.manifest?.execution.mode, "oci", `${fixture.id}: sandbox mode`);
      assert.equal(config.manifest?.execution.image, fixture.image, `${fixture.id}: sandbox image`);
      assert.deepEqual(config.manifest?.commandAllowlist, fixture.allowlist, `${fixture.id}: command allowlist`);
      assert.equal(config.processes?.[0]?.commandSpec?.executable, fixture.start.split(" ")[0], `${fixture.id}: structured start command`);
    }
  } finally {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }
}
