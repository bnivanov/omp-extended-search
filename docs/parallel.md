# parallel_search

Full Parallel V1 API for omp: `POST /v1/search`, `POST /v1/extract`, `POST /v1/tasks/runs`, and `GET /v1/tasks/runs/{run_id}` against `https://api.parallel.ai`. omp's built-in Parallel path hardcodes the old beta endpoint with `mode=fast` and a single query — this tool exposes the V1 surface.

Credentials: `/login` → Parallel, or `PARALLEL_API_KEY`. Session key first, env var as fallback.

## Operations

| `operation` | Endpoint | What it does |
|---|---|---|
| `search` *(default)* | `POST /v1/search` | Objective + keyword queries → ranked URLs with long excerpts |
| `extract` | `POST /v1/extract` | Excerpts / full content for known URLs (≤20) |
| `task` | `POST /v1/tasks/runs` + poll | Deep Research processor — multi-step browse + synthesis |
| `task_status` | `GET /v1/tasks/runs/{run_id}` | Retrieve an existing run (and its result when completed) without creating a new billed run |

## Search `mode`

| Mode | Latency (docs / measured) | ≈ cost per call (10 results) | Use when |
|---|---|---|---|
| `turbo` | ~200ms / ~0.6s | ~$0.001 | High-volume, low-latency, "good enough" retrieval |
| `basic` | ~1s / ~1.2s | ~$0.005 | Everyday agent search |
| `advanced` *(default)* | ~3s / ~1.8s | ~$0.005 | Higher-quality retrieval + compression for complex objectives |

Aliases the tool accepts (mapped into V1):

| Alias | Maps to |
|---|---|
| `fast`, `one-shot`, `one-shot-new` | `basic` |
| `agentic`, `research`, `comprehensive`, `parallel` | `advanced` |
| `minimal` | `turbo` |

## How to write good Parallel searches

Parallel wants both:

1. `objective` — the natural-language goal ("compare Exa deep vs Parallel advanced for agent research")
2. `search_queries` — 2–3 short keyword queries (3–6 words each)

If you only pass `query`, the tool uses it as both objective and a single search query. Quality depends on the keyword queries more than on a long objective alone.

Other search knobs: `max_results` (1–40, default 10; `limit`/`num_results` are aliases), `max_chars_per_result`, `max_chars_total`, `include_domains` / `exclude_domains`, `location` (ISO country code), `live_fetch`, `max_age_seconds`, `session_id` (correlate with a later extract), `client_model`.

## Extract

Use after search when a citation needs the page body:

- `urls` (≤20, required)
- `excerpts: true` (default) — focused excerpts
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
| `pro` | Hard questions | $0.10 |
| `ultra` | Deep | $0.30 |
| `ultra2x` / `ultra4x` / `ultra8x` | Max depth / breadth | up to $2.40 |

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

- Not a pure semantic "pages like this embedding" store (Exa `neural`/`deep` shines there)
- Not X-native (use `x_search`)
- Not related to omp's native Parallel path, which only ever sends beta `fast` with a single query
