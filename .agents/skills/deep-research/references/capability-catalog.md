# Research capability catalog

Source of truth for constructing a research plan. This is the **capability map** of every exposed lane. It is **not** a first-use-this ladder. The model picks the mix from these rows, then shows **chosen vs rejected** in the visible plan.

Costs are **guidance**, not quotes. Plans must say so. No per-call spend guard exists.

## Native OMP

| Capability | How | Best for | Not for | Cost / limit (guidance) |
|---|---|---|---|---|
| Everyday web lookup | `web_search` (23-provider chain) | Quick facts, docs, obvious queries | Vendor-specific knobs, X, HN, arXiv-primary, site crawls | Session-provisioned. Seconds. omp 17.0.9+ Firecrawl under this lane **only** if Firecrawl is in `providers.webSearchOrder` (installer does not set that). |
| Known-URL fetch / site scrapers | `read(URL)` (~78 handlers) | A URL you already have; HN/arXiv/PubMed/SEC/Wikipedia pages | Discovery, login walls, JS SPAs that need a real browser | $0 |
| Instant markdown of a public page | `read("https://r.jina.ai/{url}")` | Clean page text, no browser | Login walls, heavy JS, bulk crawls | $0 keyless |
| JS / bot-walled / behind-login | `browser` (Chromium) | Authenticated or stealth pages | Cheap public markdown (use `read` / Jina first) | $0 local compute; slower |
| Dead / historical pages | `read` Wayback CDX / availability | Deleted URLs, historical state | Live current content | $0 |

## Extended fleet (`xd://…`)

Invoke: `read xd://<name>` for schema, then `write` JSON to the same path. Never `xdi://`.

### Discovery / search

| Capability | Tool | Best for | Not for | Cost / limit (guidance) |
|---|---|---|---|---|
| Grounded web + synthesized answer | `tavily_search` `search` | Fast factoids and news/finance topics with an answer | Semantic “pages like this”; X; site-wide crawl as first move | basic **1 credit**; advanced **2 credits**. Researcher plan ~1,000 req/mo. ~1s basic. |
| Semantic / vertical web | `exa_search` `search` | Vague concepts; papers/people/companies/github categories | Keyword news pulse; X | auto/neural/fast ~$0.007 / 10 results; deep ~$0.012–0.020; summary +~$0.002. Seconds–12s for deep. |
| One-shot cited answer | `exa_search` `answer` | Single factual question | Multi-angle reports | ~$0.005 |
| Objective + multi-query excerpts | `parallel_search` `search` | Long excerpts for synthesis | Cheap one-liner facts | turbo ~$0.001; basic/advanced ~$0.005. Sub-second–few seconds. |
| Firecrawl SERP (web/news/images) | `firecrawl_search` `search` | Explicit Firecrawl sources, categories, domain/date/location, highlights | Everyday lookup (use `web_search`) | **2 credits / 10 results / source**, rounded up. Keyless limited. `content=none` (default) avoids per-page scrape. |
| Paper index (abstracts, passages, citation graph) | `firecrawl_search` `papers` / `paper` / `related` | Scholarly corpus inside Firecrawl; related-work graph | Website filter `categories=["research"]`; arXiv-primary ($0 first) | Same search-credit family; `k` up to 500 papers / 100 developer. |
| Developer index (issues, PRs, READMEs, docs) | `firecrawl_search` `developer` | “Where was this bug fixed?”, README/docs passages | Repo discovery / trending (use `github_search`) | **2 credits / 10 results**, rounded up. Filters: `types`, `repos`, `doc_sources`, language/topic/stars. |
| Hacker News | `hackernews_search` | HN threads, comments, front page | General web | $0. Algolia + official feeds. |
| Reddit (named subs) | `reddit_search` | Practitioner chatter in given subreddits | Global Reddit search; live official API; thread comments | $0 Arctic Shift archive. Default tech/AI subs. |
| GitHub **repositories** | `github_search` | New/trending repos (created + stars proxy) | Code, issues, PRs, docs (use Firecrawl developer index) | $0. 10 req/min unauth; 30/min with token. Search API 1000-hit cap. |
| arXiv preprints | `arxiv_search` | CS/AI primary preprints + PDF URLs | Paywalled publisher pages | $0. ~1 req / 3s polite. |
| Product Hunt launches | `producthunt_search` | Launches by **topic + date** | Keyword search (API cannot grep) | Needs Developer Token. Lists, does not search. |
| RSS / lab blogs | `feed_search` | Newsletters, Substack/Medium, `ai-labs` / `tech-news` bundles | Ad-hoc web discovery | $0 |
| X / Twitter public posts (Grok) | `x_search` | Live posts, handles, topic synthesis | Exact operators, `public_metrics`, archive, write/DM | xAI login or `XAI_API_KEY`. `focus=relevance` default; volume is broader/noisier. Capture: syndication free; Firecrawl capture spends credits. |
| X recent search (7d) | `x_api` `recent` | Exact operators, last 7 days, `public_metrics` | Grok synthesis; posts older than 7d | `X_BEARER_TOKEN`. ~$0.005/post. Default 10, max 100/page. Pass `next_token` yourself. |
| X full-archive search | `x_api` `archive` | Same operators, 2006+ | Grok synthesis; unentitled archive | Same per-post cost. Query max 1024 chars. Needs archive entitlement. |

### Fetch / extract / traverse

| Capability | Tool | Best for | Not for | Cost / limit (guidance) |
|---|---|---|---|---|
| Known-URL bodies (Exa) | `exa_search` `contents` | Pack summary/highlights/text for URLs you have | Discovery | Contents add ~$0.005–0.01 |
| Known-URL bodies (Parallel) | `parallel_search` `extract` | Excerpts / full content for ≤20 URLs | Discovery | Metered per extract |
| Tavily extract / map / crawl | `tavily_search` `extract` / `map` / `crawl` | Batch markdown; sitemap; Tavily crawl | Login walls | extract 1 cr / URL batch; map 1 cr; crawl 2 cr / job |
| Site map (cheap recon) | `firecrawl_crawl` `map` | Shape of a public site before spending per page | Page bodies | ~1 credit. Limit up to 100000 URLs. |
| One public page | `firecrawl_crawl` `scrape` | Markdown/HTML/JSON/summary; JSON mode for structured extract | Login walls (no cookies) | **1 credit / page**. JSON mode cheaper than agent for one known URL. |
| Many known URLs | `firecrawl_crawl` `batch` | Parallel scrape, max 100 URLs | Unknown URL gather | 1 credit / page × URL count |
| Managed multi-page crawl | `firecrawl_crawl` `crawl` | Public docs sites with a **named page limit** | Behind-login; unbounded “get the whole site” | **1 credit / scraped page**. Default limit 20, hard max 500. Always name `limit` in the plan. |
| LLM extract from known URL globs | `firecrawl_crawl` `extract` | `example.com/*` + prompt/schema | Unknown URLs (use agent) | Token/credit based; wait+cancel on timeout |
| Autonomous gather (URLs unknown) | `firecrawl_crawl` `agent` | “Find X wherever it lives” | One known URL (use scrape JSON) | Dynamic. Plan **must** name `max_credits` (default 100, hard max 2500). |
| Interact with a prior scrape | `firecrawl_crawl` `interact` | Click/fill on a **public** scrape session | Behind-login (use `browser`) | Session-minute credits; keep `interact_timeout` tight |
| Canonical X post(s) | `x_api` `lookup` | Ids or status URLs → text + `public_metrics` | Discovery | ~$0.005/post. Max 100 ids. |
| X reply thread | `x_api` `thread` | `conversation_id` / status URL reply tree | Threads older than 7d without `archive` | Recent search under the hood. Same per-post cost. |
| X user profile | `x_api` `user` | Handle → followers, verified, description | Posts | ~$0.010/user. |
| X user timeline | `x_api` `timeline` | Up to 3200 recent posts; `exclude` retweets/replies | Full archive of a user | ~$0.005/post. Default 10/page. |
| X volume counts | `x_api` `counts` | Bucketed hit counts, not posts | Post text | `window=recent` ~$0.005/req; `all` ~$0.010/req. `granularity` minute/hour/day. |
| Multi-hop research report | `parallel_search` `task` | Synthesized report with processor tiers | First-pass lookup | lite $0.005 · base $0.01 · core $0.025 · pro $0.10 · ultra $0.30 · ultra8x up to $2.40. **Cannot cancel.** Never start above `base` without a stated budget. |

## Keyless primary APIs (`read`)

Recipes: `skill://deep-research/references/free-apis.md`.

| Capability | Endpoint family | Cost / limit (guidance) |
|---|---|---|
| Scholarly works / citations | OpenAlex | $0 · 100k req/day polite |
| Open-access PDFs | CORE (`CORE_API_KEY`) | keyed free tier |
| Biomedical abstracts | PubMed E-utilities | $0 · 1 req / 3s keyless |
| DOI metadata | Crossref | $0 polite UA |
| Macro time series | FRED (`FRED_API_KEY`) | keyed free |
| Live quotes | Finnhub (`FINNHUB_API_KEY`) | keyed free |
| 10-K / 8-K | SEC EDGAR EFTS | $0 · custom UA required · 10 req/s |
| Prediction markets | Polymarket Gamma | $0 |
| Entity summary | Wikipedia REST | $0 |
| Public social (not X) | Bluesky XRPC | $0 |

## Construction rules

1. The tables above are the map. List every row that **could** answer, then choose. Do not default to `web_search` or Tavily because they are listed first. Do not skip `x_api` / `x_search` because they are social.
2. Corpus is a fact in the row (`Best for` / `Not for`), not a separate ladder.
3. One known URL → `read` / Jina / scrape JSON / `x_api` `lookup`. Unknown URLs → search or Firecrawl agent (with ceiling). Site shape unknown → `map` before `crawl`.
4. Behind-login → `browser`. Firecrawl has no cookies.
5. Name ceilings from the row: Firecrawl `limit` / `max_credits`, Parallel processor, `x_api` `max_results`. Parallel `pro`+ and Firecrawl `agent` / large crawls need an explicit budget.
