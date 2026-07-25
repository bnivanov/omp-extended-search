# github_search

Searches GitHub repositories via the official REST Search API, tuned for discovering new and trending projects ("trending" itself has no API — searching by creation window + stars is the standard proxy).

## Credentials

Works with none (10 requests/minute). To raise the limit (30/minute), either:

- `export GITHUB_TOKEN=...` (or `GH_TOKEN`), or
- have the `gh` CLI authenticated — the tool runs `gh auth token` automatically

## Parameters

| Parameter | Type | Notes |
|---|---|---|
| `query` | string | Free-text keywords. May be omitted if you pass qualifiers like `topics`. |
| `created_after` / `created_before` | `YYYY-MM-DD` | Repo creation window. |
| `pushed_after` | `YYYY-MM-DD` | Only repos pushed to since this date. |
| `recency` | `day` \| `week` \| `month` \| `year` | Convenience for `created_after`. |
| `min_stars` | int | Only repos with at least this many stars. |
| `language` | string | e.g. `TypeScript`, `Rust`. |
| `topics` | string[] | GitHub topic tags, e.g. `["mcp", "llm"]`. |
| `sort` | `stars` \| `forks` \| `updated` \| `best_match` | Default `best_match` (GitHub relevance). |
| `limit` | int 1–50 | Default 10 (`per_page`). |
| `page` | int ≥ 1 | 1-indexed page (default 1). Sent as the Search API `page`. |

## Notes

- Results include stars, forks, language, creation and last-push dates, description, and topics.
- "What are people building with X this month" ≈ `query` + `recency: "month"` + `sort: "stars"`.
- This searches repositories only — not code, issues, or users (different endpoints, different rate budgets).
- **Pagination:** `details.pagination` is `{ page, per_page, returned, upstream_total?, has_more, continuation_supported, next?, result_cap, max_page }`. `upstream_total` is GitHub’s `total_count`. `continuation_supported: true`; when `has_more`, `next` is `page + 1`. Text ends with `Showing N of T (page P)` (and a “more available — request page” hint when applicable).
- **1000-result ceiling:** the Search API only serves the first 1000 hits. `has_more` is capped at that ceiling (`result_cap: 1000`, `max_page = floor(1000 / per_page)`). A `page` beyond `max_page` is rejected up front with a clear error instead of GitHub’s opaque 422.
- **Retries:** bounded exponential jitter (up to 3 attempts). Retryable statuses are 408/425/429/500/502/503/504 plus pre-response transport errors; `Retry-After` is honored against the remaining deadline. Aborts normalize to `AbortError`; the tool timeout interrupts a retry backoff.
