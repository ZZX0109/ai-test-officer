# AI Test Officer Benchmark

This benchmark uses three independent target applications: `app-under-test`, `fixtures/todo-lite`, and `fixtures/order-portal-lite`. The fixture applications expose only a web page, HTTP API, health endpoint, and OpenAPI summary; the Agent does not read their internal expected answers.

`cases.json` contains 18 development requirements and `blind-cases.json` contains six frozen blind inputs. Neither file contains expected verdicts. Human labels live under `evaluation/benchmark-labels/`, which is excluded from Agent container images and mounted only into the evaluator after execution.

The benchmark report must distinguish connected, simulated, fallback, failed and human-review outcomes. Fixture data is reproducible engineering validation and must not be presented as production customer traffic.
