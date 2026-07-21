# reddit_search

Searches Reddit via the official Reddit API with OAuth2.

## Prerequisites (one-time)

1. Go to https://www.reddit.com/prefs/apps and create an app:
   - type **script**
   - redirect uri: any value (e.g. `http://localhost:8080`) — required by the form, unused
2. Set environment variables:

```bash
export REDDIT_CLIENT_ID=...        # under the app name ("personal use script")
export REDDIT_CLIENT_SECRET=...    # the app's secret
```

Optional: `REDDIT_USERNAME` + `REDDIT_PASSWORD` (uses the password grant for a user context; skip if you have 2FA), `REDDIT_USER_AGENT` (override the default UA string).

The free tier is fine for personal research use (roughly 100 requests/minute). The tool caches the OAuth token and reuses it for ~an hour.

## Parameters

| Parameter | Type | Notes |
|---|---|---|
| `query` | string *(required)* | Search text. |
| `subreddits` | string[] | Restrict to these subs (e.g. `["MachineLearning", "LocalLLaMA"]`). |
| `sort` | `relevance` \| `hot` \| `top` \| `new` \| `comments` | Default `relevance`. |
| `time` | `hour` \| `day` \| `week` \| `month` \| `year` \| `all` | Time window for top/controversial-style sorting, default `month`. |
| `recency` | `day` \| `week` \| `month` \| `year` | Convenience alias for `time`. |
| `limit` | int 1–100 | Default 10. |
| `include_comments` | boolean | Also fetch the top 3 comments for the top 5 threads. Default false (one extra request per thread). |

## Notes

- Results include subreddit, score, comment count, author, date, the permalink, and the external link for link posts.
- When rate-limit headroom gets low the tool says so in the output.
- Alternative without any signup: `exa_search` with `include_domains: ["reddit.com"]` covers a lot of "what does Reddit think" queries with zero setup.
