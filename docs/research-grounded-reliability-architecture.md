# Research-grounded reliability architecture

## Decision

AI Test Officer uses a deterministic safety kernel with selective LLM
augmentation. The model may retrieve and compose trusted scenario contracts,
explain ambiguous evidence, and abstain. It may not invent shell commands,
selectors, routes, oracles, permissions, or evidence references.

This is an architectural constraint, not prompt tuning. A run is only eligible
for a formal gate after a deterministic compiler and the Artifact v2 validator
have accepted it.

## Research translated into engineering controls

- **Grounded action space.** BrowserGym and WebArena show the value of
  executable environments and standardized action/observation spaces. Mind2Web
  shows that grounding to relevant HTML reduces the search space. PlanBench
  motivates closed actions with explicit preconditions and effects. In this
  repository, `compiledPlanContract` is that closed action domain: route,
  ordered actions, bound selectors, oracles, and evidence kinds.
- **Selective prediction.** Work on abstention and cascaded prediction shows
  that a system should defer outside its competence region. A missing contract,
  ambiguous scenario, invalid evidence link, or unresolved conflict produces a
  harness gap or human review; it is never silently repaired into a pass.
- **Rubric-based evaluation.** G-Eval and Prometheus 2 motivate explicit
  criteria and structured evaluator outputs. The LLM Judge receives a minimal
  conflict packet and a fixed failure taxonomy rather than the entire report.
- **Judge calibration.** MT-Bench, JudgeBench, and related judge research show
  position, verbosity, self-enhancement, and correctness weaknesses. Therefore
  the LLM cannot override deterministic `fail` or `blocked`, and it is scored
  separately for transport success, valid evidence references, attribution,
  calibration, and abstention.
- **Heterogeneous jury.** The deterministic judge and the LLM supplement form a
  heterogeneous jury. They are deliberately not interchangeable: rules decide
  safety facts, while the model explains only genuine conflicts or unknown
  attribution.

## Unified execution pipeline

1. Retrieve candidate scenarios from project identity, impact graph, routes,
   capabilities, and requirement terms.
2. Reject cross-project candidates and scenarios without an executable
   contract. Record these as retrieval errors or harness gaps, not model errors.
3. Let deterministic routing select high-confidence known scenarios. Use the
   LLM only for close candidates, multi-page composition, or ambiguity.
4. Compile the plan against the scenario contract. Syntax validation is
   followed by semantic sequence, selector, oracle, permission, evidence, and
   budget validation.
5. Execute in a fresh attempt and atomically persist evidence even when an
   action fails.
6. Compute coverage, assertion success, artifact integrity, evidence grounding,
   and machine gate independently.
7. Invoke the LLM Judge only for a real conflict or unknown attribution. Invalid
   JSON, transport failure, or fabricated Evidence IDs leave the machine gate
   unchanged.
8. Evaluate development, exposed regression, and sealed blind datasets
   separately. A blind set becomes a postmortem regression set once labels or
   failure mechanics have influenced implementation.

## Metrics that prevent misleading claims

Always report scheduling completion, execution start/success, requirement
coverage/pass, artifact integrity, evidence grounding, gate eligibility,
machine gate, judge recommendation, and final status separately.

AI value is reported through paired lane comparisons and must include false
release, false block, human-review rate, plan executability, evidence-reference
accuracy, provider/compile/harness failure rates, latency, tokens, consistency,
and confidence intervals. Results with model fallback are not valid model
results. Exposed blind results are never reused as evidence of generalization.

## Primary references

- Zheng et al., [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)
- Liu et al., [G-Eval](https://arxiv.org/abs/2303.16634)
- Varshney et al., [The Art of Abstention](https://aclanthology.org/2021.acl-long.84/)
- Kim et al., [Prometheus 2](https://arxiv.org/abs/2405.01535)
- Verga et al., [Replacing Judges with Juries](https://arxiv.org/abs/2404.18796)
- Tan et al., [JudgeBench](https://arxiv.org/abs/2410.12784)
- Geng et al., [JSONSchemaBench](https://arxiv.org/abs/2501.10868)
- Drouin et al., [BrowserGym](https://arxiv.org/abs/2412.05467)
- Zhou et al., [WebArena](https://arxiv.org/abs/2307.13854)
- Deng et al., [Mind2Web](https://arxiv.org/abs/2306.06070)
- Valmeekam et al., [PlanBench](https://arxiv.org/pdf/2206.10498)
