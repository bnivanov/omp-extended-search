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
| `model` | string | xAI model. Default `grok-4.3`; `grok-4.6` is the newer flagship (~1.6× input / 2.4× output cost per 1M tokens). |
| `reasoning_effort` | `low` \| `medium` \| `high` \| `xhigh` | Depth vs latency. Default `high`. `xhigh` requires grok-4.6+ and degrades to `high` on older models. |
| `focus` | `relevance` \| `volume` | `relevance` (default) favors the best posts; `volume` broadens coverage across handles/viewpoints. |
| `recency` | `day` \| `week` \| `month` \| `year` | Convenience window; maps to `from_date`. |
| `limit` | number | Max citations returned. Default `10`. Schema-constrained to **1–30** (the real maximum) — values above 30 are rejected by the schema rather than silently capped. |
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
- **`firecrawl`** (~3–8s/post, spends Firecrawl credits) — adds retweets and top-comment threads. Needs `FIRECRAWL_API_KEY`. If you request `capture_provider: "firecrawl"` without that credential, the tool **falls back to syndication and says so** — a leading note in the text output plus `details.response.capture = { requested, used, reason }` (it no longer downgrades silently).

Capture runs in parallel (6 at a time) and is best-effort: deleted or protected posts are annotated `⚠ capture: ...` and the rest still come back.

## Pagination & timeouts

There is no page/cursor parameter (`continuation_supported: false`). `limit` caps how many citations are returned; when Grok cited more than `limit`, the trailing line notes truncation and tells you to raise the limit or narrow the query. The main xAI Responses request has its **own 120s timeout** (separate from per-post capture timeouts), and that deadline interrupts retry backoff. Billed POSTs (xAI + Firecrawl capture) retry `408` / `425` / `429` / `502` / `503` / `504` plus transport errors — **not `500`**. Syndication GETs still retry `500`. Aborts normalize to `AbortError`.

## Model & effort guidance

Live benchmarking (July 2026, same prompt across combinations) landed on:
- `grok-4.3` / `high` — the default. Deepest historical reach, best value.
- `grok-4.3` / `low` or `medium` — quick pulse checks, cheaper.
- `grok-4.6` — the Aug-2026 flagship ("most intelligent and fastest", 500k context) at $2.00 in / $0.50 cached / $6.00 out per 1M tokens vs grok-4.3's $1.25 / $0.20 / $2.50 (~1.6×/2.4×). Not yet re-benchmarked against grok-4.3 — opt in when quality justifies the premium; `xhigh` effort is grok-4.6+ only.
- `grok-4.5` / `low` — premium, well-written synthesis at roughly 4–5× the tokens and ~2× the latency.
- `grok-4.5` / `medium` — skip; it regressed (fewest sources, shallowest window) in testing.

xAI reasoning effort is `low`/`medium`/`high`/`xhigh` (xhigh on grok-4.6+; older models degrade it to `high`) and cannot be disabled; there is no server-side `auto`. Numbers shift as xAI changes models — treat this as a starting point, not gospel.

## Cost (billing change 2026-09-21)

**Effective 2026-09-21 12:00 PT**, xAI replaces the $5-per-1k-calls X Search billing with **per-resource billing**:

| Resource | Price |
|---|---|
| Posts fetched | **$5 per 1,000 posts** |
| User profiles fetched | **$10 per 1,000 profiles** |

**Parent and quoted posts count** toward the post total — a thread-heavy or quote-dense result set bills more than the citation count suggests. Profile fetches trigger on handle expansion (`allowed_handles`/`excluded_handles` matching still costs profile reads for candidates).

What this means per search: `reasoning_effort: "high"` + `focus: "volume"` + `limit: 30` can plausibly fetch hundreds of posts + dozens of profiles in one call — roughly **10× the old per-call assumption**. Before 2026-09-21 the per-call rate ($5/1k calls) applies. After, budget accordingly:

- Prefer `limit: 10` (default) unless the pipeline genuinely needs 30.
- Use `focus: "relevance"` (default) for pointed questions; reserve `volume` for coverage passes that justify the post count.
- Narrow with `recency`/`from_date`/`to_date` and handle filters — smaller pools mean fewer fetched resources.
- The tool's `reasoning_effort` dial controls *Grok's* token spend, not the search-resource billing; both lines appear on the same invoice.

## Defaults & configuration

Set env vars before launching omp to change defaults globally:

- `OMP_XSEARCH_MODEL` — default model (`grok-4.3`)
- `OMP_XSEARCH_EFFORT` — default effort, `low` | `medium` | `high` | `xhigh` (`high`)

## Confirm settings before each search (optional)

`focus`, `reasoning_effort`, `limit`, the window, and `capture` all change cost, latency, and what comes back. The **deep-research skill** covers X along with every other research tool — visible plan in chat, numbered options, then wait. Not an alwaysApply rule; do not use the `ask` tool.

```bash
./install.sh x --with-confirm-rule
# or once for the whole toolkit:
./install.sh all --with-confirm-rule
```

That installs [`.agents/skills/deep-research/SKILL.md`](../.agents/skills/deep-research/SKILL.md) and removes any leftover `omp-search-confirm` rule. **Chat** gate (plan → you reply with a number), not a per-call UI popup. Keep `approvalMode: yolo` (or `tools.approval.x_search: allow`) so the tool runs quietly after you pick. Only use `prompt` if you want a hard dialog every call.

## What it can't do

- Write actions (post/reply/DM/like), DMs, protected/private content
- Exact views/bookmarks, operator search, thread reconstruction, user timelines, volume counts, streaming firehose, full archive — use [`x_api`](x-api.md) (X API v2 bearer + credits)

Best-in-class for reading and reasoning about public X via Grok. For exact metrics, operators, threads, and archives, use `xd://x_api`.
