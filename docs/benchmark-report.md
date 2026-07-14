# Benchmark Report

AI Test Officer now ships an 18-case benchmark catalog whose logical labels remain `todo_lite` and `order_portal_lite`. The labels are intentionally preserved as the human annotation version. Runtime execution is defined separately in `data/benchmark/execution-map.json`: `todo_lite` runs on the repository `app-under-test`, while `order_portal_lite` runs on the independent `customer-portal-lite` target. The catalog is intentionally human-labelled and keeps expected release dispositions outside the target applications.

Project 1 is not substituted into these 18 cases. It is tracked as the separate 19th case in `data/benchmark/challenge-cases.json`, with `evaluationScope=challenge_only`. Its result must be reported separately from the baseline benchmark.

The default contract test validates the catalog shape and boots both independent fixtures. Full agent runs should persist one `runId` per case and report requirement coverage, evidence completeness, failure attribution, false release/block rates, retries, duration, token usage, Judge mode, and fallback status. Fixture results are reproducible engineering measurements, not production customer metrics.

Run the contract checks with `npm test`. Run the deterministic Judge case evaluation with `npm run judge:eval`; its JSON output is written under `reports/judge-eval/` and includes agreement, false-pass, false-block, evidence citation completeness, and human-review rate.

The repeated LLM experiment is explicit and budgeted. Set `JUDGE_LLM_REPEAT_ENABLED=1` and run `npm run judge:repeat` to execute the 18-case core Judge set three times with `max_tokens=3200`. The policy reserves at most 54 calls and 172,800 output tokens. Additional security cases remain in deterministic evaluation and are reported as excluded from this repeated budget. Normal tests do not invoke the provider. If the reserved token or estimated cost limit is exceeded, the report is marked `budget_exhausted` rather than silently truncating the experiment.
