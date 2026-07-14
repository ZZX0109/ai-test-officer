# Judge Evaluation

The Judge evaluation set covers product bugs, test-script issues, environment failures, insufficient evidence, flaky runs, missing context, prompt injection, and forged evidence references. Each case has an expected verdict and is evaluated against the deterministic layered Judge.

The report records verdict agreement, false-release rate, false-block rate, evidence citation completeness, and human-review rate. LLM-assisted runs must additionally record provider status, fallback mode, policy version, and invalid-output handling. No finding may create an evidence ID; release conclusions must cite IDs already collected in the run.
