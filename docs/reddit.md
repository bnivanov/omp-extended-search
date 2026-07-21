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
| `limit` | int 1–50 | Default 10. |

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
- NSFW posts are dropped.
- If a subreddit times out, the others still return — failures are listed at the bottom.
- Optional: `REDDIT_USER_AGENT` overrides the default User-Agent string.
- **Rate limits:** Arctic Shift returns `Too many complex queries. Please slow down.` under parallel multi-sub load. Prefer 1–3 subs per call, serialize batches, and simplify the query (drop heavy OR chains). Retry after a short pause.
- Invoke via omp xdev: `read` / `write` `xd://reddit_search` (not `xdi://`).
