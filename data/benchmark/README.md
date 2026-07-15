# AI Test Officer Benchmark

This benchmark uses three independent target applications: `app-under-test`, `fixtures/todo-lite`, and `fixtures/order-portal-lite`. The fixture applications expose only a web page, HTTP API, health endpoint, and OpenAPI summary; the Agent does not read their internal expected answers.

`cases.json` contains 18 development requirements and `blind-cases.json` contains six frozen blind inputs. The blind manifest uses numbered case IDs and opaque `fixtureVariantId` tokens. It contains no expected verdict, failure class, category, fault name, or expected-evidence list. The opaque token is interpreted only inside the target fixture or evidence-collection harness and is never expanded into an Agent prompt.

Run development and blind experiments separately. `BENCHMARK_SPLIT=blind` requires `BENCHMARK_DEVELOPMENT_EXPERIMENT_ID` pointing to a completed evaluator report whose development acceptance has `readyForBlind: true`. The runner reads that aggregate gate only; evaluator labels must never be mounted into the Agent/API/worker process.

Human labels live under `evaluation/benchmark-labels/`, which is excluded from Agent container images and mounted only into the evaluator after execution. Labels join to completed runs through the numbered benchmark ID; the evaluator does not expose the label table or target-side variant mapping to the planner, Judge, browser worker, or report prompt.

The benchmark report must distinguish connected, simulated, fallback, failed and human-review outcomes. Fixture data is reproducible engineering validation and must not be presented as production customer traffic.
