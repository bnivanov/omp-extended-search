# reddit_search

Searches Reddit posts via **Arctic Shift** ([arctic-shift.photon-reddit.com](https://arctic-shift.photon-reddit.com)) — a third-party public archive of Reddit data.

**No Reddit account. No API key. No app approval.**

## Why not the official Reddit API?

In late 2025 Reddit rolled out the [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy). Creating a script app at reddit.com/prefs/apps now requires manual approval first — you hit a wall that just links the policy. For personal research, waiting on Reddit support is not worth it. Arctic Shift is the practical alternative.

## Honest limits

| What you get | What you don't |
|---|---|
| Live-ish posts from named subreddits | Official Reddit live ranking (hot / true relevance) |
| Keyword filter + time window | Global “search all of Reddit” with no sub named |
| Score + comment counts, permalinks, selftext | Per-thread top comments |
| Default tech/AI sub bundle when you omit `subreddits` | A guarantee the archive stays up forever (it's volunteer-run) |

## Parameters

| Parameter | Type | Notes |
|---|---|---|
| `query` | string | Search text. Required unless you pass `subreddits` and just want recent posts. |
| `subreddits` | string[] | Subs to search (without `r/`). If omitted, uses LocalLLaMA, MachineLearning, ClaudeAI, OpenAI. Pass your own list anytime. |
| `sort` | `new` \| `top` | `new` (default) = newest first; `top` = highest score inside the time window. |
| `time` | `hour` \| `day` \| `week` \| `month` \| `year` | Window, default `month`. |
| `recency` | `day` \| `week` \| `month` \| `year` | Alias for `time`. |
| `since_days` | number | Last N days (overrides `time` / `recency`). |
| `limit` | int 1–50 | Default 10. Sent to Arctic Shift per subreddit, clamped to the archive maximum of 100 (no longer hardcoded to 25). |
| `before` | number \| string | Continuation upper bound on `created_utc` (unix seconds or date string). Pass the previous page’s `pagination.next` (oldest returned post’s `created_utc`) to page further back. Paired with the recency `after` lower bound — not an opaque cursor. |

## Examples

```text
query="coding agents"
→ searches the default tech/AI bundle

query="RAG evaluation", subreddits=["MachineLearning","LocalLLaMA"], sort="top", recency="week"
→ top posts this week in those two subs

subreddits=["LocalLLaMA"], sort="new", limit=15
→ latest posts in r/LocalLLaMA (no keyword)
```

## Notes

- Results link back to reddit.com permalinks.
- NSFW posts are dropped client-side; deleted/removed title shells are dropped; `[removed]`/`[deleted]` selftext is cleared. Date-window filtering and cross-sub dedupe also happen client-side after the archive response.
- **Pagination:** `details.pagination` is `{ page, per_page, returned, upstream_total?, has_more, continuation_supported, next?, filtered_out? }`. `continuation_supported: true` via `before` (not a page number — `page` is always reported as 1). `has_more` is derived from **pre-filter** per-sub fetch counts (a full archive page and/or merge overflow past `limit`), not the post-filter `returned`. `filtered_out` explains why `returned` can be short of what the archive sent (NSFW/removed/date filtering and dedupe). When `has_more`, `next` is the oldest returned post’s `created_utc` — pass it back as `before`. Text ends with a `Showing N of T (page 1)` line, including `filtered_out=…` when non-zero.
- If a subreddit times out, the others still return — failures are listed at the bottom.
- Optional: `REDDIT_USER_AGENT` overrides the default User-Agent string.
- **Rate limits:** Arctic Shift returns `Too many complex queries. Please slow down.` under parallel multi-sub load. Prefer 1–3 subs per call, serialize batches, and simplify the query (drop heavy OR chains). Multi-sub calls are sequential with a ~1.5 s gap between subs.
- **Retries:** bounded exponential jitter (up to 3 attempts) per subreddit GET. Retryable statuses are 408/425/429/500/502/503/504 plus pre-response transport errors; `Retry-After` is honored against the remaining deadline. Aborts normalize to `AbortError`; the tool timeout interrupts a retry backoff.
- Invoke via omp xdev: `read` / `write` `xd://reddit_search` (not `xdi://`).
