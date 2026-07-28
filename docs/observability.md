# Observability: local traces + metrics (no Docker required)

Kritya can export OTel-shaped traces and metrics to a local OpenTelemetry
Collector, which fans traces to [Phoenix](https://github.com/Arize-ai/phoenix)
and metrics to Prometheus/Grafana. Every piece below runs as a plain binary —
no Docker.

## 1. Install the three backends

**Phoenix** (traces):

```bash
pip install arize-phoenix
phoenix serve # listens on http://localhost:6006, OTLP ingest on /v1/traces
```

**Prometheus** (metrics storage):
Download a binary for your OS from https://prometheus.io/download/, then:

```bash
./prometheus --config.file=observability/prometheus.yml
```

**Grafana** (dashboards + alerting):
Install via your OS package manager (e.g. `brew install grafana` /
`apt install grafana`), then run it pointed at the provisioning directory in
this repo:

```bash
GF_PATHS_PROVISIONING=observability/grafana/provisioning grafana-server

# UI at http://localhost:3000 (default admin/admin)

```

## 2. Install and run the OTel Collector

Download `otelcol` (core distribution is enough — no contrib components
used) from
https://github.com/open-telemetry/opentelemetry-collector-releases/releases
for your OS/arch, then:

```bash
./otelcol --config observability/otelcol-config.yaml
```

This listens for OTLP/HTTP on `localhost:4318`, forwards traces to Phoenix,
and exposes metrics on `localhost:8889` for Prometheus to scrape.
`observability/otelcol-config.yaml`'s `prometheus:` exporter sets
`resource_to_telemetry_conversion.enabled: true`, which is required for
resource attributes like `service.instance.id` (the per-session id that keeps
concurrent kritya sessions' counters from merging into one series) to appear
as Prometheus labels — the collector's default `prometheus` exporter drops
resource attributes otherwise.

## 3. Point Kritya at the collector

```bash
export KRITYA_OTEL=off # skip the local file/console sink; OTLP-only
export KRITYA_OTEL_ENDPOINT=http://localhost:4318
kritya
```

Use a real session (a few tool calls) and then:

- Open http://localhost:6006 — Phoenix shows the trace, with each tool call
  as a nested span.
- Open http://localhost:3000 — the "Kritya" dashboard shows tool call rate,
  error rate, and p95 latency once Prometheus has scraped a few intervals
  (10s, per `observability/prometheus.yml`).

## Why three separate tools instead of one

- **Phoenix** — inspects individual traces: exactly what a tool call
  received and returned, useful for debugging one run.
- **Prometheus + Grafana** — aggregates across many runs: rate, error %,
  latency trends, and alerting. Traces don't answer "is this getting worse
  over time" well; metrics do.
- **The Collector** — decouples Kritya from both. Kritya always speaks OTLP
  to one local endpoint; adding, removing, or swapping a backend is a
  collector config change, not a Kritya code change.
