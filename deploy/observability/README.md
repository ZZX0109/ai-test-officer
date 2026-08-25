# Observability deployment

The Agent exposes the low-cardinality operational SLO snapshot at:

```text
GET /api/operations/slo/prometheus
```

It contains no Run IDs, Artifact URIs, credentials or tenant payloads. The
Prometheus rule and dashboard templates in this directory deliberately alert
on `slo_unavailable`; an empty metric response must never be interpreted as a
healthy deployment.

`prometheus-rules.yml` and `ato-slo-dashboard.json` are deployment templates.
They become production evidence only after they are installed, scraped and
observed in the target environment. The repository's isolated acceptance
report does not claim that a live monitoring platform has been provisioned.
