import ast
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
result = {}

def node_id(kind, value):
    return f"{kind}_{hashlib.sha256(value.encode()).hexdigest()[:16]}"

for relative in sys.argv[2:]:
    file = (root / relative).resolve()
    if root not in file.parents and file != root:
        raise SystemExit("path_escape")
    source = file.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(file))
    file_id = node_id("file", relative)
    nodes = [{"id": file_id, "kind": "file", "label": relative, "file": relative, "confidence": "high"}]
    edges = []
    for item in ast.walk(tree):
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            symbol_id = node_id("symbol", f"{relative}:{item.name}")
            nodes.append({"id": symbol_id, "kind": "symbol", "label": item.name, "file": relative, "line": item.lineno, "confidence": "high"})
            edges.append({"from": file_id, "to": symbol_id, "kind": "exports", "reason": f"{relative} declares {item.name}"})
            for decorator in getattr(item, "decorator_list", []):
                if isinstance(decorator, ast.Call) and decorator.args and isinstance(decorator.args[0], ast.Constant) and isinstance(decorator.args[0].value, str):
                    text = ast.unparse(decorator.func)
                    if any(text.endswith(f".{method}") for method in ("get", "post", "put", "patch", "delete")):
                        route = decorator.args[0].value
                        route_id = node_id("api", route)
                        nodes.append({"id": route_id, "kind": "api-route", "label": route, "file": relative, "line": item.lineno, "confidence": "high"})
                        edges.append({"from": symbol_id, "to": route_id, "kind": "serves", "reason": f"{text} registers {route}"})
    result[relative] = {"sha256": hashlib.sha256(source.encode()).hexdigest(), "nodes": nodes, "edges": edges}

print(json.dumps(result, ensure_ascii=False))
