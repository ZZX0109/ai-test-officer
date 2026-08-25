# Observability deployment

The Agent exposes the low-cardinality operational SLO snapshot at:

```text
GET /api/operations/slo/prometheus
```

It contains no Run IDs, Artifact URIs, credentials or tenant payloads. The
Prometheus rule and dashboard templates in this directory deliberately alert
on `slo_unavailable`; an empty metric response must never be interpreted as a
healthy deployment.

`prometheus-rules.yml`, `prometheus.yml` and `ato-slo-dashboard.json` are
installed by the production-acceptance Compose stack's `observability`
profile. The default acceptance stack does not require the monitoring images;
run `docker compose --profile observability up` to enable them. Prometheus
uses a persistent `prometheus-data` volume and Grafana uses a persistent
`grafana-data` volume; the acceptance monitor queries the live Prometheus rule
state and Grafana health before teardown.
