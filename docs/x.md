# x_search

Searches public posts on X (Twitter) through xAI's native `x_search`, using your own xAI credentials. Non-Grok models running in omp are otherwise blind to live X content — only xAI has the data pipe. The tool POSTs to `https://api.x.ai/v1/responses` and returns a direct answer plus deduplicated x.com permalinks.

## Requirements

- omp with custom tools enabled (default)
- One of:
  - xAI OAuth — `/login` → xAI Grok (needs SuperGrok or X Premium+)
  - `XAI_API_KEY` — an xAI API key with tool access

Auth order: session OAuth → session API key → `XAI_OAUTH_TOKEN` / `XAI_API_KEY` env vars.

## Parameters

The model fills these; you rarely set them by hand.

| Parameter | Type | Notes |
|---|---|---|
| `query` | string *(required)* | What to search for. |
| `model` | string | xAI model. Default `grok-4.3`. |
| `reasoning_effort` | `low` \| `medium` \| `high` | Depth vs latency. Default `high`. |
| `focus` | `relevance` \| `volume` | `relevance` (default) favors the best posts; `volume` broadens coverage across handles/viewpoints. |
| `recency` | `day` \| `week` \| `month` \| `year` | Convenience window; maps to `from_date`. |
| `limit` | number | Max citations returned. Default `10`, capped at `30`. |
| `allowed_handles` | string[] | Restrict to these handles (max 20). Mutually exclusive with `excluded_handles`. |
| `excluded_handles` | string[] | Exclude these handles (max 20). |
| `from_date` / `to_date` | `YYYY-MM-DD` | Explicit date range. |
| `enable_image_understanding` | boolean | Let the search analyze images in posts. |
| `enable_video_understanding` | boolean | Let the search analyze videos (X only). |
| `capture` | boolean | Resolve each cited permalink to its real post text + engagement. Default off. |
| `capture_provider` | `syndication` \| `firecrawl` | `syndication` (default, free) or `firecrawl` (spends Firecrawl credits). |

## Volume vs relevance

xAI's `x_search` has no min/max-results knob, so how many distinct posts you get back is driven by four levers:

- `focus` — `volume` asks Grok for breadth; `relevance` (default) asks for the best posts
- `reasoning_effort` — `high` means more internal X-search calls and deeper reach
- `limit` — also acts as a target count in the prompt, so raising it nudges Grok to surface more
- date range / handle filters — widen or narrow the pool

In practice, on a pointed question (`relevance`) you get fewer sources but more distinct entities per source; `volume` returns more raw posts with more repetition. For maximum coverage: `focus: "volume"` + `reasoning_effort: "high"` + `limit: 30`. For a tight answer: defaults with a small `limit`.

## Capturing full post content

By default the tool returns Grok's synthesized answer plus permalinks — the citations carry no raw post text (xAI leaves `cited_text` empty). Pass `capture: true` and every cited permalink is resolved to the real post, inlined under each source:

- **`syndication`** (default, free, ~200–400ms/post) — via `cdn.syndication.twimg.com`. Post text, author, likes, replies, plus the quoted tweet. No API key, no credits.
- **`firecrawl`** (~3–8s/post, spends Firecrawl credits) — adds retweets and top-comment threads. Needs `FIRECRAWL_API_KEY`; falls back to `syndication` when the key is absent.

Capture runs in parallel (6 at a time) and is best-effort: deleted or protected posts are annotated `⚠ capture: ...` and the rest still come back.

## Model & effort guidance

Live benchmarking (July 2026, same prompt across combinations) landed on:

- `grok-4.3` / `high` — the default. Deepest historical reach, best value.
- `grok-4.3` / `low` or `medium` — quick pulse checks, cheaper.
- `grok-4.5` / `low` — premium, well-written synthesis at roughly 4–5× the tokens and ~2× the latency.
- `grok-4.5` / `medium` — skip; it regressed (fewest sources, shallowest window) in testing.

xAI reasoning effort is `low`/`medium`/`high` only and cannot be disabled; there is no server-side `auto`. Numbers shift as xAI changes models — treat this as a starting point, not gospel.

## Defaults & configuration

Set env vars before launching omp to change defaults globally:

- `OMP_XSEARCH_MODEL` — default model (`grok-4.3`)
- `OMP_XSEARCH_EFFORT` — default effort, `low` | `medium` | `high` (`high`)

Per call, the driver model may pass `model` or `reasoning_effort` directly.

## Confirm settings before each search (optional)

`focus`, `reasoning_effort`, `limit`, the window, and `capture` all change cost, latency, and what comes back. The **global** plan-first rule covers X along with every other research tool:

```bash
./install.sh x --with-confirm-rule
# or once for the whole toolkit:
./install.sh all --with-confirm-rule
```

That installs [rules/omp-search-confirm.md](../rules/omp-search-confirm.md) only — one always-on gate for `web_search` and all extended tools, with X heuristics included. **Chat** gate (propose → you say go), not a per-call UI popup. Keep `approvalMode: yolo` (or `tools.approval.x_search: allow`) so the tool runs quietly after you approve the plan. Only use `prompt` if you want a hard dialog every call.

## What it can't do

- Write actions (post/reply/DM/like), DMs, protected/private content
- Exact views/bookmarks, streaming firehose, full archive — those need the paid X API ($200–$42,000/mo); this tool costs your existing xAI subscription or API key usage

Best-in-class for reading and reasoning about public X. For writing or full historical archives, you need the paid X API.
