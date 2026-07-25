# hackernews_search

Searches Hacker News and fetches its front-page feeds. Free, keyless — no credentials, no env vars.

- `operation=search` (default) uses the Algolia HN Search API — full-text over stories *and* comments.
- `operation=feed` uses the official Firebase API for the current top/new/best/ask/show/job lists.

## Parameters

| Parameter | Type | Notes |
|---|---|---|
| `query` | string | Search text. Required for `search`. |
| `operation` | `search` \| `feed` | Default `search`. |
| `tags` | string[] | `story`, `comment`, `ask_hn`, `show_hn`, `job`, `poll`. Multiple values are ANDed. |
| `sort` | `relevance` \| `date` | Default `relevance`; `date` = most recent first. |
| `min_points` | int | Only stories with at least this many points. |
| `min_comments` | int | Only stories with at least this many comments. |
| `recency` | `day` \| `week` \| `month` \| `year` | Only hits from that window. |
| `since_days` | number | Only hits from the last N days (overrides `recency`). |
| `limit` | int 1–50 | Max results for `search`, default 10. |
| `page` | int ≥ 1 | For `operation=search` only: 1-indexed page (default 1). Sent to Algolia 0-indexed (`page - 1`). |
| `feed` | `top` \| `new` \| `best` \| `ask` \| `show` \| `job` | For `operation=feed`, default `top`. |
| `count` | int 1–30 | For `operation=feed`, default 10. |

## Notes

- Every result includes the HN item link (`news.ycombinator.com/item?id=…`) plus the external link when there is one.
- Comment hits include the story title they belong to and a text snippet.
- Rate limits are generous; no key means nothing to configure.
- **Pagination (`search`):** `details.pagination` is `{ page, per_page, returned, upstream_total?, has_more, continuation_supported, next? }`. `upstream_total` is Algolia `nbHits`. `continuation_supported: true`; when `has_more`, `next` is `page + 1`. Text ends with `Showing N of T (page P)` (and a “more available — request page” hint when applicable).
- **Pagination (`feed`):** the Firebase id list is complete, so `upstream_total` is the full feed length and `continuation_supported: false` — there is **no** `page`/`cursor` for feeds. `has_more` stays false; if the list is longer than `count`, the trailing line says the set may be truncated and to **raise `count` or switch feed** instead of paging. Item fetches still fan out concurrently after the id list loads.
- **Retries:** bounded exponential jitter (up to 3 attempts) on the HTTP GETs. Retryable statuses are 408/425/429/500/502/503/504 plus pre-response transport errors; `Retry-After` is honored against the remaining deadline. Aborts normalize to `AbortError`; the tool timeout interrupts a retry backoff.
- **Product / brand queries:** prefer `tags: ["story"]` and quoted names (`"Google Stitch"`, `"Claude Design"`). Bare tokens like `Google` or unquoted multi-OR blobs match huge comment noise.
- **Front page right now:** `operation: "feed"`, `feed: "top"` — not a keyword search.
- Invoke via omp xdev: `read` / `write` `xd://hackernews_search` (not `xdi://`).
