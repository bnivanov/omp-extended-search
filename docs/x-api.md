# x_api

Read-only X API v2 for exact post search, metrics, threads, users, timelines, and volume counts. Independent of [`x_search`](x.md) (xAI Grok synthesis). Native omp only fetches a known `x.com` URL via Nitter or blocks; it has no v2 client.

## Requirements

- omp with custom tools enabled
- An X developer bearer token with credits. **Never** `XAI_API_KEY`.

Auth order: session `getApiKey("x")` / `getApiKey("twitter")` → `X_BEARER_TOKEN` → `TWITTER_BEARER_TOKEN`.

Keep the token in the environment or a session credential. Do not put it in the repo. `.gitignore` already ignores `.env` / `.env.*`.

## Cost (guidance, not a quote)

Pay-per-use. No per-call spend guard.

| Resource | Guidance |
|---|---|
| Post read | ~$0.005 each |
| User read | ~$0.010 each |
| Counts recent | ~$0.005 / request |
| Counts all | ~$0.010 / request |

Default page size is **10**. Pass `next_token` yourself — the tool never auto-walks pages. 24h UTC dedupe may reduce actual spend. Cap 3M Post reads / month on pay-per-use.

## Operations

| `operation` | Endpoint | When |
|---|---|---|
| `recent` (default) | `GET /2/tweets/search/recent` | Last 7 days. Operators. `sort_order` recency/relevancy. |
| `archive` | `GET /2/tweets/search/all` | Full archive (2006+). Needs archive entitlement. |
| `lookup` | `GET /2/tweets` | Canonical post(s) + `public_metrics`. Ids or status URLs. |
| `thread` | recent search `conversation_id:` | Reply tree for a post. Older than 7d → `archive` + that operator. |
| `user` | `GET /2/users/by/username/:name` | Profile + follower counts. |
| `timeline` | `GET /2/users/:id/tweets` | Up to 3200 recent posts. `exclude: ["retweets","replies"]`. |
| `counts` | `/2/tweets/counts/recent` or `/all` | Volume buckets. `window=recent\|all`, `granularity=minute\|hour\|day`. |

## Parameters

| Parameter | Notes |
|---|---|
| `query` | X operators (`from:`, `lang:`, `-is:retweet`, `conversation_id:`, …). Required for recent/archive/counts unless `allowed_handles` is set. Self-serve max 512 chars (recent) / 1024 (archive). |
| `allowed_handles` | Convenience `from:` clause (OR if several). |
| `max_results` / `limit` | 10–100, default 10. |
| `next_token` | From `details.pagination.next_token`. |
| `sort_order` | `recency` or `relevancy` (search only). |
| `recency` / `from_date` / `to_date` / `start_time` / `end_time` | Windows. `start_time` XOR `since_id`; `end_time` XOR `until_id`. `recent` rejects starts older than 7 days. |
| `ids` / `id` | Lookup (max 100). Status URLs accepted. |
| `conversation_id` | Thread. |
| `username` | user / timeline (with or without `@`). |
| `exclude` | timeline: `retweets`, `replies`. |
| `window` | counts: `recent` (default) or `all`. |
| `granularity` | counts: `minute` / `hour` (default) / `day`. |

Each post is rendered as `https://x.com/{handle}/status/{id}` plus handle, date, and `public_metrics`.

## vs `x_search`

- Topic / “what’s the vibe” → `x_search` (Grok).
- Exact query, metrics, thread, handle dump, 7d/archive, volume → `x_api`.
- Known URL without a bearer → syndication capture on `x_search`, or `read` / browser.

## Out of scope

Write, like, follow, DM, home timeline, filtered stream, Spaces, Communities, Ads, protected posts.

## Example

```text
write xd://x_api
{"operation":"recent","query":"from:xai lang:en -is:retweet","max_results":10}
```
