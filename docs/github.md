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
| `limit` | int 1–50 | Default 10. |

## Notes

- Results include stars, forks, language, creation and last-push dates, description, and topics.
- "What are people building with X this month" ≈ `query` + `recency: "month"` + `sort: "stars"`.
- This searches repositories only — not code, issues, or users (different endpoints, different rate budgets).
