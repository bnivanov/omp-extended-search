---
name: omp-search-confirm
description: "Global research gate: before any web/extended search tool, recommend source mix + settings and wait for chat OK"
alwaysApply: true
---

# Research settings gate (omp-extended-search)

When the user asks for something that needs **live outside research** — web facts, news, social chatter, papers, launches, repos, feeds, comparisons, multi-source synthesis — **do not call** research tools immediately.

That includes: built-in `web_search`, and any installed extended tool (`firecrawl_search`, `firecrawl_crawl`, `exa_search`, `parallel_search`, `x_search`, `hackernews_search`, `reddit_search`, `producthunt_search`, `github_search`, `arxiv_search`, `feed_search`).

Instead, use **this session's main model** (you) to propose a plan first, then wait.

## Invocation (after approval)

Extended tools mount on omp's **`xd://` device bus** (discoverable custom tools).
They are **not** top-level function calls and there is **no `xdi://` scheme**.

- Schema: `read` `xd://hackernews_search` (etc.)
- Run: `write` JSON args to the same `xd://<tool_name>` path; the write result is the output
- Wrong prefix (`xdi://`, bare path, inventing a filename) creates a workspace file and does **not** run the tool

Built-in `web_search` may be native or `xd://web_search` depending on omp version — use what the session exposes. omp 17.0.9+ can use Firecrawl, including limited keyless access, behind that ordinary lane **only when Firecrawl is explicitly selected in `providers.webSearchOrder`**. The automatic provider chain remains credential-gated, and this installer does not set provider order. This does not make `firecrawl_search` the default. When the plan is approved, call tools with the agreed settings via the exposed path.

## 1. Restate the goal

One short sentence: what answer is needed and any constraints (recency, sources, depth, budget).

## 2. Recommend the tool mix

Pick **one** primary path, or an explicit combination. Prefer the cheapest path that can still answer well. omp's built-in `web_search` is the default everyday lane; extended tools fill gaps it covers poorly.

| Need | Prefer | Why |
|---|---|---|
| Quick fact / docs / obvious query | **`web_search` alone** | Fast, already configured; no extra spend |
| Firecrawl-specific web/news/images sources, GitHub/research/PDF categories, domain/date/location filters, optional page scrape, or raw Firecrawl metadata | **`firecrawl_search`** | Direct access to advanced Firecrawl controls the native lane does not expose |
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
| Discover every URL on a site / sitemap | **`firecrawl_crawl` operation=map** | Cheap discovery, one call |
| Extract one known page as markdown | **`firecrawl_crawl` operation=scrape** | Prefer free `read <url>` for simple public pages |
| Traverse many pages of a public site | **`firecrawl_crawl` operation=crawl** | Only managed crawl primitive; bills per page |
| User said “expand” / high stakes / uncertain | **`web_search` + one or more extended tools** | Merge citations after |

Also note when **not** to use these tools (codebase-only, pure reasoning, files already in context).

## 3. Recommend concrete settings

For each tool you plan to call, list the resolved settings and a **one-clause reason** for every non-default. Structure the request the way that tool actually works — don't invent params.

### If using `web_search`
- note provider preference if known; otherwise “session default”

### If using `firecrawl_search`
- Use only for Firecrawl-specific sources/categories/filters/scrape controls or raw provider metadata; ordinary lookups stay on built-in `web_search`. omp 17.0.9+ uses Firecrawl underneath only when configured in `providers.webSearchOrder`
- `query` (required), `limit` (default `10`, range 1–100 **per source**), `sources` (`web` default; optional `news`/`images`), and optional `categories` (`github`/`research`/`pdf`)
- Filters when useful: mutually exclusive `include_domains`/`exclude_domains`; `recency` (`hour`/`day`/`week`/`month`/`year`) or raw Firecrawl `tbs`; `location` and `country`
- `highlights` defaults `true` for focused web descriptions/news snippets; `content` defaults `none` (no full-page scrape), or request `markdown`/`summary`/`links`
- Scrape controls only when `content` is not `none`: `only_main_content`, `max_age_ms`, `scrape_timeout_ms`; `ignore_invalid_urls` is a top-level search option
- `timeout_ms` defaults to `60000`. There is no pagination; choose one bounded request
- Authentication resolves omp's stored Firecrawl/provider session credential first, then `FIRECRAWL_API_KEY`, then limited keyless mode; either authenticated source raises limits. Warn that multi-source `limit` applies independently to each source, search credits round up per source, and optional per-result scraping adds credits and latency
- Expect grouped `web`/`news`/`images` data plus optional `warning`, `id`, and `creditsUsed`; retain partial item errors rather than treating one scrape failure as total failure

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

### If using `firecrawl_crawl`
- `operation`: `map` | `scrape` | `crawl` | `status` | `cancel`
- map: `url` (required), optional `search`, `limit` (up to 100000), `include_subdomains`
- scrape: `url` (required), `formats` (default `["markdown"]`), `only_main_content` (default `true`), `max_age_ms`
- crawl: `url` (required), `limit` (default `20`, hard max `500`), `max_discovery_depth`, `include_paths`/`exclude_paths`, `scrape_options` (`formats`, `only_main_content`), `poll_timeout_ms` (default `300000`), `wait` (default `true`)
- status/cancel: `job_id` (required)
- Firecrawl sends no cookies or session, so this reaches **public pages only**; anything behind a login needs the `xd://browser` device
- Crawling bills **per scraped page** — the plan MUST name the page `limit` before approval

### Cost / latency snapshot
Order-of-magnitude is fine:
- web_search / HN / reddit / github / arxiv / feeds / Product Hunt: free or already-provisioned / seconds
- firecrawl_search: keyless is limited; search costs credits per source, and optional full-page scraping adds per-result credits + latency
- firecrawl_crawl: map is cheap discovery; scrape/crawl bill per page and crawl cost scales with page count — plan MUST name the page limit before approval (crawl default 20, hard max 500); slower when `wait=true`
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
