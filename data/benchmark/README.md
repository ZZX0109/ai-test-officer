# AI Test Officer Benchmark

This benchmark uses three independent target applications: `app-under-test`, `fixtures/todo-lite`, and `fixtures/order-portal-lite`. The fixture applications expose only a web page, HTTP API, health endpoint, and OpenAPI summary; the Agent does not read their internal expected answers.

`cases.json` contains 18 requirements with category, risk and expected release disposition. Expected dispositions are human-authored evaluation labels, not runtime fixtures. Run metadata should record `projectId`, `runId`, scenario version, judge policy version, fallback mode, retry count, duration and evidence count.

The benchmark report must distinguish connected, simulated, fallback, failed and human-review outcomes. Fixture data is reproducible engineering validation and must not be presented as production customer traffic.
