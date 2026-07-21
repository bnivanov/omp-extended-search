---
name: omp-search-confirm
description: "Global research gate: before any web/extended search tool, recommend source mix + settings and wait for chat OK"
alwaysApply: true
---

# Research settings gate (omp-extended-search)

When the user asks for something that needs **live outside research** — web facts, news, social chatter, papers, launches, repos, feeds, comparisons, multi-source synthesis — **do not call** research tools immediately.

That includes: built-in `web_search`, and any installed extended tool (`exa_search`, `parallel_search`, `x_search`, `hackernews_search`, `reddit_search`, `producthunt_search`, `github_search`, `arxiv_search`, `feed_search`).

Instead, use **this session's main model** (you) to propose a plan first, then wait.

## 1. Restate the goal

One short sentence: what answer is needed and any constraints (recency, sources, depth, budget).

## 2. Recommend the tool mix

Pick **one** primary path, or an explicit combination. Prefer the cheapest path that can still answer well. omp's built-in `web_search` is the default everyday lane; extended tools fill gaps it covers poorly.

| Need | Prefer | Why |
|---|---|---|
| Quick fact / docs / obvious query | **`web_search` alone** | Fast, already configured; no extra spend |
| Semantic “pages like this”, verticals (papers/people/companies/github), multi-angle SERP | **`exa_search`** | Neural/deep + categories beat generic SERP |
| Objective + multi-query with long excerpts | **`parallel_search` search** | Long excerpts for synthesis |
| Known URLs need body text | **`exa_search` contents** or **`parallel_search` extract** | Dedicated fetch |
| Multi-hop research report / deep synthesis | **`parallel_search` task** | Processor tiers synthesize; costlier |
| X / Twitter discourse, handles, threads | **`x_search`** | Live X pipe (not generic web) |
| Hacker News discussion or front page | **`hackernews_search`** | HN search + official feeds; free |
| Reddit posts in named subs | **`reddit_search`** | Arctic Shift archive; free, no Reddit app |
| Product launches by topic/date | **`producthunt_search`** | PH lists by topic — no keyword search |
| New / trending GitHub repos | **`github_search`** | Creation window + stars proxy |
| Academic papers | **`arxiv_search`** | arXiv API; free |
| Lab blogs / newsletters / RSS | **`feed_search`** | Bundles or any feed URL; free |
| User said “expand” / high stakes / uncertain | **`web_search` + one or more extended tools** | Merge citations after |

Also note when **not** to use these tools (codebase-only, pure reasoning, files already in context).

## 3. Recommend concrete settings

For each tool you plan to call, list the resolved settings and a **one-clause reason** for every non-default. Structure the request the way that tool actually works — don't invent params.

### If using `web_search`
- note provider preference if known; otherwise “session default”

### If using `exa_search`
- `operation`: `search` | `answer` | `contents`
- `type`: `auto` (default) | `fast` | `neural` | `deep`
- `contents`: `summary` (default) | `highlights` | `text` | `all` | `none`
- `num_results` / filters / `category` when useful
- Heuristics: short factual → `answer`; known vertical → `category`; hard multi-angle → `type=deep`; cheap skim → `type=fast`

### If using `parallel_search`
- `operation`: `search` | `extract` | `task`
- search: `mode` (`turbo`|`basic`|`advanced`), `objective`, 2–3 short `search_queries`, `max_results`
- extract: `urls`, `excerpts`/`full_content`
- task: `processor` (`lite`→`ultra8x`); start `lite`/`base` unless user asked deep

### If using `x_search`
- `focus` — `relevance` (default) for pointed “what’s best / is it X” questions; `volume` only for breadth, sentiment sweeps, or discovering many handles (volume = more raw posts, more repetition)
- `reasoning_effort` — `high` (default) for depth/historical reach; `low`/`medium` for a quick pulse
- `limit` — default `10`; raise toward `30` for volume sweeps; lower (e.g. `5`) for a tight answer
- `from_date`/`to_date` or `recency` — pin an explicit window when the topic is time-sensitive
- `allowed_handles`/`excluded_handles` — only when the user named specific accounts (mutually exclusive)
- `capture` — only if they want real post text/engagement, not just the summary; default free `syndication`; `capture_provider: firecrawl` only when they explicitly want retweets/top replies and accept Firecrawl spend
- `model` — leave default unless they want premium synthesis (`grok-4.5`)

### If using `hackernews_search`
- `operation`: `search` (default) vs `feed` (front page lists)
- search: `query`, optional `tags` (`story`/`comment`/`show_hn`/…), `sort` (`relevance`|`date`), `recency`/`min_points`, `limit`
- feed: `feed` (`top`|`new`|`best`|`ask`|`show`|`job`), `count`

### If using `reddit_search`
- `query` and/or explicit `subreddits` (defaults are LocalLLaMA, MachineLearning, ClaudeAI, OpenAI)
- `sort`: `new` | `top` · `recency`/`time`/`since_days` · `limit`
- Say clearly this is the Arctic Shift archive, not the live official Reddit API

### If using `producthunt_search`
- **No keyword search** — only topic + date + order
- `topic` slug (e.g. `artificial-intelligence`, `developer-tools`), `order` (`votes`|`newest`), `recency`/`since_days`, `limit`

### If using `github_search`
- `query` and/or `topics`, `language`, `min_stars`
- time window via `recency` or `created_after` / `pushed_after`
- `sort`: `stars` for “what’s hot”, `updated` for activity, default `best_match`

### If using `arxiv_search`
- `query`, optional category (cs.AI, cs.LG, cs.CL, …), author, date/recency, `limit`

### If using `feed_search`
- `bundle`: `ai-labs` | `tech-news`, **or** explicit `urls`
- optional `query` keyword filter, `since_days`, `limit` / `per_feed_limit`

### Cost / latency snapshot
Order-of-magnitude is fine:
- web_search / HN / reddit / github / arxiv / feeds / Product Hunt: free or already-provisioned / seconds
- exa auto+summary: ~$0.01 / few seconds; deep higher
- parallel turbo/basic/advanced: ~$0.001–0.005 / sub-second–few seconds
- parallel task lite/base/core: cents–tens of cents / tens of seconds+
- x_search: uses xAI login; effort=high is slower/deeper

## 4. Wait for approval

Stop after the plan. Do **not** call research tools until the user approves or adjusts
(“go”, “use HN + reddit”, “web only”, “skip parallel”, “top this week on PH”, etc.).

When approved, call tools with the agreed settings (or the user’s tweaks). After results, synthesize; only then suggest a follow-up deeper pass if gaps remain.

## 5. Skip this gate when

- User explicitly says to run immediately / skip confirmation / “just search”
- User already specified exact tool + settings to run now
- The task needs no live outside research
- A follow-up call in the **same** approved plan (e.g. extract URLs from a search the user just approved) — don’t re-prompt unless settings change materially

## Example shape (keep it tight)

```text
Goal: …
Recommended mix: web_search + hackernews_search + reddit_search
  • web_search — quick baseline
  • hackernews_search: operation=search, query="…", sort=date, recency=week, limit=10
    reason: catch HN threads from this week
  • reddit_search: query="…", subreddits=[LocalLLaMA,ClaudeAI], sort=top, recency=week
    reason: practitioner chatter in AI subs (Arctic Shift archive)
Rough cost/latency: free / a few seconds
Approve / tweak?
```
