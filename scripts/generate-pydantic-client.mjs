import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const document = JSON.parse(await readFile(path.join(root, "docs", "openapi.json"), "utf8"));
const schemas = document.components?.schemas ?? {};

const pythonName = (value) => {
  const name = String(value).replace(/[^A-Za-z0-9_]/g, "_");
  const safe = /^[A-Za-z_]/.test(name) ? name : `field_${name}`;
  return new Set(["from", "class", "pass", "global", "async", "await", "raise", "in", "is", "not", "or", "and"])
    .has(safe) ? `${safe}_` : safe;
};
const className = (ref) => pythonName(String(ref).split("/").at(-1));
const literal = (value) => JSON.stringify(value)
  .replaceAll("true", "True")
  .replaceAll("false", "False")
  .replaceAll("null", "None");

function schemaType(schema = {}) {
  if (schema.$ref) return className(schema.$ref);
  if (schema.const !== undefined) return `Literal[${literal(schema.const)}]`;
  if (schema.enum) return `Literal[${schema.enum.map(literal).join(", ")}]`;
  if (schema.oneOf || schema.anyOf) {
    const items = schema.oneOf ?? schema.anyOf;
    const withoutNull = items.filter((item) => item.type !== "null");
    const union = withoutNull.map(schemaType).join(", ") || "Any";
    return items.length !== withoutNull.length ? `Optional[Union[${union}]]` : `Union[${union}]`;
  }
  if (schema.allOf) return schemaType(schema.allOf.at(-1));
  if (schema.type === "array") return `list[${schemaType(schema.items)}]`;
  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      return `dict[str, ${schemaType(schema.additionalProperties)}]`;
    }
    return "dict[str, Any]";
  }
  if (schema.type === "integer") return "int";
  if (schema.type === "number") return "float";
  if (schema.type === "boolean") return "bool";
  if (schema.type === "string") return "str";
  return "Any";
}

const lines = [
  "# Generated from docs/openapi.json. DO NOT EDIT.",
  "from __future__ import annotations",
  "",
  "from typing import Any, Literal, Optional, Union",
  "from pydantic import BaseModel, ConfigDict, Field, RootModel",
  ""
];
const modelNames = [];
for (const [rawName, schema] of Object.entries(schemas)) {
  const name = pythonName(rawName);
  if (!(schema.type === "object" || schema.properties)) {
    lines.push(`${name} = ${schemaType(schema)}`, "");
    continue;
  }
  modelNames.push(name);
  lines.push(`class ${name}(BaseModel):`, "    model_config = ConfigDict(extra=\"forbid\", populate_by_name=True)");
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  if (!Object.keys(properties).length) {
    lines.push("    root: dict[str, Any] = Field(default_factory=dict)");
  }
  for (const [rawField, fieldSchema] of Object.entries(properties)) {
    const field = pythonName(rawField);
    const annotation = schemaType(fieldSchema);
    const isRequired = required.has(rawField);
    const type = isRequired ? annotation : `Optional[${annotation}]`;
    const alias = field !== rawField ? `, alias=${JSON.stringify(rawField)}` : "";
    if (isRequired) {
      lines.push(`    ${field}: ${type} = Field(...${alias})`);
    } else if (fieldSchema.default !== undefined) {
      lines.push(`    ${field}: ${type} = Field(default=${literal(fieldSchema.default)}${alias})`);
    } else {
      lines.push(`    ${field}: ${type} = Field(default=None${alias})`);
    }
  }
  lines.push("");
}
lines.push("for _model in [");
for (const name of modelNames) lines.push(`    ${name},`);
lines.push("]:", "    _model.model_rebuild()", "");

const outputDir = path.join(root, "clients", "python", "ai_test_officer_client");
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "models.py"), `${lines.join("\n")}\n`);
await writeFile(path.join(outputDir, "__init__.py"), "from .models import *  # noqa: F401,F403\n");
