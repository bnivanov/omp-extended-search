# reddit_search

Searches Reddit via the official Reddit API with OAuth2.

## Prerequisites (one-time) — create a free "script" app

Reddit hides this under developer prefs. Use the **old Reddit** page; it's clearer:

### 1. Open the apps page

While logged into Reddit, open:

**https://old.reddit.com/prefs/apps**

(If that redirects weirdly, try https://www.reddit.com/prefs/apps and scroll all the way down.)

### 2. Create the app

At the bottom of the page click **"are you a developer? create an app..."**
(or **"create another app"** if you've made one before).

Fill in:

| Field | What to put |
|---|---|
| **name** | anything, e.g. `omp-reddit-search` |
| **type** | select the **script** radio button (not "web app", not "installed app") |
| **description** | optional, leave blank |
| **about url** | leave blank |
| **redirect uri** | `http://localhost:8080` — required by the form, we never open it |

Click **create app**.

### 3. Copy the two values

After creation the page shows a box for your app:

```
omp-reddit-search                    script
  personal use script
  ← THIS short string under the app name is REDDIT_CLIENT_ID
  secret: ← THIS longer string is REDDIT_CLIENT_SECRET
```

- **CLIENT_ID** = the short random string sitting directly under the app name (often labeled "personal use script"). It is *not* the name you typed.
- **CLIENT_SECRET** = the value next to `secret`.

### 4. Export them

```bash
export REDDIT_CLIENT_ID=the_short_string_under_the_name
export REDDIT_CLIENT_SECRET=the_secret_value
```

Optional:

- `REDDIT_USER_AGENT` — override the default UA string
- `REDDIT_USERNAME` + `REDDIT_PASSWORD` — only if you want a user-context token; **skip if you have 2FA** (password grant breaks with 2FA). Client-credentials alone is enough for search.

### Can't find the page?

- You must be logged in.
- New Reddit UI sometimes buries it — stick to **old.reddit.com/prefs/apps**.
- On mobile/app: use a desktop browser; the prefs/apps page is desktop-only.
- If Reddit asks you to verify email first, do that, then reload the apps page.

The free tier is fine for personal research (~100 requests/minute). The tool caches the OAuth token and reuses it for ~an hour.

## Parameters

| Parameter | Type | Notes |
|---|---|---|
| `query` | string *(required)* | Search text. |
| `subreddits` | string[] | Restrict to these subs (e.g. `["MachineLearning", "LocalLLaMA"]`). |
| `sort` | `relevance` \| `hot` \| `top` \| `new` \| `comments` | Default `relevance`. |
| `time` | `hour` \| `day` \| `week` \| `month` \| `year` \| `all` | Time window for top-style sorting, default `month`. |
| `recency` | `day` \| `week` \| `month` \| `year` | Convenience alias for `time`. |
| `limit` | int 1–100 | Default 10. |
| `include_comments` | boolean | Also fetch the top 3 comments for the top 5 threads. Default false. |

## Notes

- Results include subreddit, score, comment count, author, date, the permalink, and the external link for link posts.
- When rate-limit headroom gets low the tool says so in the output.
- Alternative with zero signup: `exa_search` with `include_domains: ["reddit.com"]` covers a lot of "what does Reddit think" queries.
