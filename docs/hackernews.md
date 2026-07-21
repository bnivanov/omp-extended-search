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
| `limit` | int 1–50 | Max results, default 10. |
| `feed` | `top` \| `new` \| `best` \| `ask` \| `show` \| `job` | For `operation=feed`, default `top`. |
| `count` | int 1–30 | For `operation=feed`, default 10. |

## Notes

- Every result includes the HN item link (`news.ycombinator.com/item?id=…`) plus the external link when there is one.
- Comment hits include the story title they belong to and a text snippet.
- Rate limits are generous; no key means nothing to configure.
- **Product / brand queries:** prefer `tags: ["story"]` and quoted names (`"Google Stitch"`, `"Claude Design"`). Bare tokens like `Google` or unquoted multi-OR blobs match huge comment noise.
- **Front page right now:** `operation: "feed"`, `feed: "top"` — not a keyword search.
- Invoke via omp xdev: `read` / `write` `xd://hackernews_search` (not `xdi://`).
