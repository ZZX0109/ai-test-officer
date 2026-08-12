import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type MonacoWorkerEnvironment = {
  getWorker(moduleId: string, label: string): Worker;
};

const runtime = globalThis as typeof globalThis & { MonacoEnvironment?: MonacoWorkerEnvironment };
runtime.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  }
};

// Keep the editor fully local. The React wrapper's default CDN loader hangs
// indefinitely in restricted/offline environments and only shows “Loading…”.
loader.config({ monaco });

// Local VS Code Light+ inspired theme. The language contributions above make
// syntax highlighting work without any CDN or network dependency.
monaco.editor.defineTheme("ato-vscode-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "008000", fontStyle: "italic" },
    { token: "keyword", foreground: "AF00DB" },
    { token: "keyword.control", foreground: "AF00DB" },
    { token: "string", foreground: "A31515" },
    { token: "string.key.json", foreground: "0451A5" },
    { token: "string.value.json", foreground: "A31515" },
    { token: "number.json", foreground: "098658" },
    { token: "keyword.json", foreground: "0000FF" },
    { token: "delimiter.bracket.json", foreground: "383838" },
    { token: "delimiter.array.json", foreground: "383838" },
    { token: "delimiter.colon.json", foreground: "6E7781" },
    { token: "delimiter.comma.json", foreground: "6E7781" },
    { token: "number", foreground: "098658" },
    { token: "type", foreground: "267F99" },
    { token: "type.identifier", foreground: "267F99" },
    { token: "identifier", foreground: "001080" },
    { token: "function", foreground: "795E26" },
    { token: "delimiter", foreground: "383838" },
    { token: "tag", foreground: "800000" },
    { token: "attribute.name", foreground: "FF0000" },
    { token: "attribute.value", foreground: "0000FF" },
    { token: "regexp", foreground: "811F3F" }
  ],
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#1F2328",
    "editorLineNumber.foreground": "#8C959F",
    "editorLineNumber.activeForeground": "#24292F",
    "editor.lineHighlightBackground": "#F6F8FA",
    "editor.selectionBackground": "#ADD6FF",
    "editor.inactiveSelectionBackground": "#E5EBF1",
    "editorIndentGuide.background1": "#E7E9EC",
    "editorIndentGuide.activeBackground1": "#B6BCC4",
    "editorBracketHighlight.foreground1": "#0431FA",
    "editorBracketHighlight.foreground2": "#319331",
    "editorBracketHighlight.foreground3": "#7B3814",
    "editorCursor.foreground": "#0F172A",
    "editorWhitespace.foreground": "#D0D7DE",
    "editorGutter.background": "#FFFFFF",
    "editorOverviewRuler.border": "#FFFFFF",
    "minimap.background": "#FFFFFF"
  }
});
