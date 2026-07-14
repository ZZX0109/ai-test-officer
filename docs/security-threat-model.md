# Security Threat Model

## Assets

The system protects credentials, requirement and diff text, screenshots, DOM/network/console evidence, traces, run bundles, project files, and release decisions.

## Trust boundaries

- Workbench to Agent API: token and CORS boundary.
- Agent to target project: declared project root, process and URL boundary.
- Remote connectors to the public network: SSRF and response-size boundary.
- LLM provider: untrusted external processor; prompts contain untrusted source text.
- Artifact readers: run and project authorization boundary.

## Threats and controls

| Threat | Control | Residual risk |
| --- | --- | --- |
| SSRF to private or metadata addresses | DNS resolution, private address rejection, manual redirect validation | DNS rebinding needs deployment network policy |
| Workspace path escape | `path.relative()` containment checks | External projects require explicit grant |
| Fake Judge evidence | Evidence IDs are sanitized against collected evidence | Human review remains necessary for ambiguous cases |
| Prompt injection in DOM or diff | Separate untrusted payload section and deterministic baseline | LLM provider isolation is deployment-specific |
| Credential leakage | AES-GCM, external master key, redaction and atomic writes | Production should use a secret manager |
| Artifact disclosure | Token-gated artifact route and run-scoped records | Development loopback bypass is for local mode only |
| Malicious target process | Explicit workspace and process controls | Full container sandbox is deployment work |

Release findings without valid evidence references are rejected or downgraded to `needs_review`. Simulated and fallback results remain visible as such.
