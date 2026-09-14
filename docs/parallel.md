# parallel_search

Full Parallel V1 API for omp: `POST /v1/search`, `POST /v1/extract`, `POST /v1/responses`, `POST /v1/tasks/runs`, and `GET /v1/tasks/runs/{run_id}` against `https://api.parallel.ai`. omp's built-in Parallel path hardcodes the old beta endpoint with `mode=fast` and a single query — this tool exposes the V1 surface.

Credentials: `/login` → Parallel, or `PARALLEL_API_KEY`. Session key first, env var as fallback.

## Operations

| `operation` | Endpoint | What it does |
|---|---|---|
| `search` *(default)* | `POST /v1/search` | Objective + keyword queries → ranked URLs with long excerpts |
| `extract` | `POST /v1/extract` | Excerpts / full content for known URLs (≤20) |
| `responses` | `POST /v1/responses` | Cited answer + structured outputs with a `reasoning.effort` dial |
| `task` | `POST /v1/tasks/runs` + poll | Deep Research processor — multi-step browse + synthesis |
| `task_status` | `GET /v1/tasks/runs/{run_id}` | Retrieve an existing run (and its result when completed) without creating a new billed run |

## Search `mode`

| Mode | Latency (docs / measured) | Price (per 1k results) | Use when |
|---|---|---|---|
| `turbo` | ~200ms / ~0.6s | **$1/1k** | High-volume, low-latency, "good enough" retrieval — English + Japanese only, no domain/path prefixes |
| `fast` | ~1s | **$1/1k** | First-class V1 mode — the vendor's recommended agent mode |
| `basic` | ~1s / ~1.2s | **$5/1k** | Everyday agent search |
| `advanced` *(default)* | ~3s / ~1.8s | **$5/1k** | Higher-quality retrieval + compression for complex objectives |

Public modes cap results at **20** upstream (server clamps + warns above; the tool clamps `max_results` to 20). `after_date` (GA freshness filter): only sources published/updated after the given ISO date. `fetch_policy.max_age_seconds` has a **600s minimum** — `live_fetch: true` maps to it.

Alias table (legacy beta names → V1):

| Alias | Maps to |
|---|---|
| `one-shot`, `one-shot-new` | `fast` |
| `minimal` | `turbo` |
| `agentic`, `research`, `comprehensive`, `parallel` | `advanced` |

`fast` is first-class in V1 — mapping it to `basic` overbills 5× ($1/1k vs $5/1k); that alias bug was fixed 2026-09.

## How to write good Parallel searches

Parallel wants both:

1. `objective` — the natural-language goal ("compare Exa deep vs Parallel advanced for agent research")
2. `search_queries` — 2–3 short keyword queries (3–6 words each)

If you only pass `query`, the tool uses it as both objective and a single search query. Quality depends on the keyword queries more than on a long objective alone.

Other search knobs: `max_results` (1–20, default 10; `limit`/`num_results` are aliases — public modes cap at 20 upstream), `max_chars_per_result`, `max_chars_total`, `include_domains` / `exclude_domains` (turbo: no domain/path prefixes), `location` (ISO country code from the 37-code list — `gb`, not `uk`), `after_date` (ISO date freshness filter), `live_fetch` (maps to the 600s `max_age_seconds` minimum), `max_age_seconds` (≥600), `session_id` (correlate with a later extract), `client_model`.

## Extract

- `urls` (≤20, required)
- V1 shape: `excerpts` / `full_content` live under `advanced_settings{excerpt_settings, full_content}` — the top-level Beta shape is dead, and the stale `parallel-beta` header is no longer sent.
- `excerpts: false` is no longer accepted upstream (excerpts can't be disabled) — the tool accepts the flag for compatibility and ignores it.
- `full_content: true` — full page content (larger, slower). When you ask for it, the text output **renders `full_content`** (it no longer silently prefers excerpts). Each document body is capped at 8000 characters in the text view, with a clear truncation marker; the untruncated payload is preserved under `details.rawResponse`.
- `objective` / `search_queries` — focus what the excerpts capture
- `session_id` — tie back to a prior search
- `max_chars_total` — cap total returned characters

Extract has no page/cursor parameter (`continuation_supported: false`).

## Task / Deep Research processors

`operation: "task"` creates a run and polls until completion (default budget 180s, override with `poll_timeout_ms`).

| Processor | Role | List price / run |
|---|---|---|
| `lite` | Narrow, cheap | $0.005 |
| `base` *(default)* | Standard research | $0.01 |
| `core` | Stronger multi-hop | $0.025 |
| `core2x` | 2× core budget | $0.05 |
| `pro` | Hard questions | $0.10 |
| `ultra` | Deep | $0.30 |
| `ultra2x` / `ultra4x` / `ultra8x` | Max depth / breadth | up to $2.40 |

Nine `-fast` processor variants exist at the same price with lower latency — the vendor steers new workloads away from them toward the Responses API; the tool does not expose them.

Response `basis[]` is **per-element** (Per-Element Basis GA, 2026-08-24): entries carry dot-delimited `field` paths with confidence/reasoning, and the `field-basis-2025-11-25` beta header is retired (removed from every request).

Input: `task_input` wins if set, else `objective`/`query` text. Optional `output_schema`:

- plain string → treated as a text schema description
- bare JSON Schema object → structured JSON output
- `{ "type": "auto" }` → let Parallel decide
- `{ "type": "text", "description": "…" }` / `{ "type": "json", "json_schema": {…} }` → explicit wrappers

Also: `previous_interaction_id` to continue from a prior run, `include_domains` / `exclude_domains` as source policy.

**Task creation is never retried.** `POST /v1/tasks/runs` is not idempotent — a lost response after accept would start a second billed run — so transport retries are disabled on create. Status/result polls (GETs) still retry, including `500`.

### Task runs cannot be cancelled

Verified live: `DELETE /v1/tasks/runs/{id}` returns `405`, and there is no `/cancel` route. A run that exceeds `poll_timeout_ms` (or is aborted client-side) **keeps executing and billing** on Parallel's side. The tool surfaces this as:

```text
details.orphanedRun = { runId, reason, cancellable: false }
```

(`reason` is `"poll-timeout"` or `"aborted"`.) Use `task_status` later with that `run_id` to pick the run back up — it is a GET, not a new billed create.

### `task_status`

`operation: "task_status"` with required `run_id` hits `GET /v1/tasks/runs/{run_id}` and, when status is `completed`, also fetches `/result`. Use it to recover orphaned runs or check a run you already created. It does **not** start a new processor run.

## Responses API (cited answers)

`operation: "responses"` hits `POST /v1/responses` (OpenAI-compatible) with `model: parallel` and a `reasoning.effort` dial:

| Effort | Price |
|---|---|
| `low` | **$10/1k** |
| `medium` *(default)* | **$50/1k** |
| `high` | **$250/1k** — budgeted tier: never without an explicit stated budget |

Returns a cited answer with per-element `basis` (field paths + confidence); `output_schema` (string or JSON Schema) yields structured outputs. Sync latency 5–60s. The upstream API also supports SSE streaming — the tool uses the synchronous call.

## Rate limits & free credits

- POST-only rate limits: Search/Extract **600/min**, Tasks **2000/min**.
- Orgs with a card on file get **$5/month in free credits**.

List prices from [Parallel pricing](https://docs.parallel.ai/getting-started/pricing); your plan may differ.

## Pagination

`search` and `extract` report a normalized `details.pagination` block (`page`, `per_page`, `returned`, optional `upstream_total`, `has_more`, `continuation_supported`, optional `next`) plus a trailing human-readable line. Neither operation has a page/cursor parameter (`continuation_supported: false`) — raise `max_results` or narrow the query instead of asking for another page. Task / `task_status` return a single run, not a result page.

## Resilience

Billed POSTs (`search` / `extract`) retry with bounded exponential jitter and honor `Retry-After` against the remaining deadline. Retryable statuses: `408` / `425` / `429` / `502` / `503` / `504`, plus pre-response transport errors; **`500` is excluded** on billed POSTs (the server may already have billed). Unbilled GETs (task status/result polls and `task_status`) also retry `500`. Job creation (`operation=task` POST) is never retried. Aborts normalize to `AbortError`; the tool timeout interrupts a retry backoff.

## Environment defaults

| Env | Default | Effect |
|---|---|---|
| `PARALLEL_API_KEY` | — | Auth fallback after the omp session key |
| `OMP_PARALLEL_DEFAULT_MODE` | `advanced` | Default search `mode` |
| `OMP_PARALLEL_DEFAULT_PROCESSOR` | `base` | Default task `processor` |
| `OMP_PARALLEL_MAX_POLL_MS` | `180000` | Task poll budget (ms) |

## What it's not

- Not a pure semantic "pages like this embedding" store (Exa `auto`/`deep` tiers shine there)
- Not X-native (use `x_search` for Grok synthesis, `x_api` for operators/metrics)
- Not related to omp's native Parallel path, which only ever sends beta `fast` with a single query
