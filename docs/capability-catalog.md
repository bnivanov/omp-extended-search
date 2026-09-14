# Research capability catalog

Source of truth for constructing a research plan. This is the **capability map** of every exposed lane. It is **not** a first-use-this ladder. The model picks the mix from these rows, then shows **chosen vs rejected** in the visible plan.

**Mount honesty (2026-09-13 audit):** this catalog is a **static** capability map. A device may be **absent from a session's mount list** even though its row exists here (probe record: both Firecrawl devices were unmounted while cataloged). Check `read xd://<tool>` before fanning out; unmounted lane → brief-level fallback (mount check; see the deep-research skill's routing table / pipeline §2).

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
| Grounded web + synthesized answer | `tavily_search` `search` | Fast factoids and news/finance topics with an answer | Semantic “pages like this”; X; site-wide crawl as first move | basic **1 credit**; advanced **2 credits**. Researcher plan ~1,000 req/mo. ~1s basic. Aug-2026 params: `include_domains_mode`, `language`/`filter_by_language`, `safe_search`, `chunks_per_source`. ⚠ `auto_parameters` is cost-opaque — may silently upgrade to advanced (2 cr). |
| Semantic / vertical web | `exa_search` `search` | Vague concepts; companies/publications/news/people categories | Keyword news pulse; X | Mar-2026 pricing: **$7/1k** ≤10 results (text+highlights bundled), +$1/1k above 10. Type enum: `instant|fast|auto|deep-lite|deep|deep-reasoning` — `neural`/`keyword` are dead server-side (400 risk); `deep-lite` $12/1k, `deep-reasoning` $15/1k. `outputSchema`+`systemPrompt` grounded synthesis feeds the claim schema (deep-research skill pipeline §3). |
| One-shot cited answer | `exa_search` `answer` | Single factual question | Multi-angle reports | **$5/1k** (verified current). `model` enum: `exa|exa-pro|exa-research|exa-fast`; also `systemPrompt`/`outputSchema`. |
| Objective + multi-query excerpts | `parallel_search` `search` | Long excerpts for synthesis | Cheap one-liner facts | Modes: turbo **$1/1k** (~200ms, en+ja), **fast $1/1k** (do not alias to basic — 5× overbilling bug fixed 2026-09), basic/advanced **$5/1k**. Public modes cap results at **20** (our schema allows 40 — server clamps + warns). `after_date` freshness filter GA. |
| Firecrawl SERP (web/news/images) | `firecrawl_search` `search` | Explicit Firecrawl sources, categories, domain/date/location, highlights | Everyday lookup (use `web_search`) | **2 credits / 10 results / source**, rounded up. Keyless limited. `content=none` (default) avoids per-page scrape. ⚠ Device may be absent from the mount list (see header note) — check before planning. ⚠ 2026-11-16: `categories=["research"]` cutover moves to Research Index records (`data.research`). |
| Paper index (abstracts, passages, citation graph) | `firecrawl_search` `papers` / `paper` / `related` | Scholarly corpus inside Firecrawl; related-work graph | Website filter `categories=["research"]` (pre-cutover); arXiv-primary ($0 first) | **Research index is FREE** (~43M abstracts, biomedical-heavy, pmid/pmcid/doi ids — not search-credit family, corrected 2026-09). `k` up to 500 papers / 100 developer. |
| Developer index (issues, PRs, READMEs, docs) | `firecrawl_search` `developer` | “Where was this bug fixed?”, README/docs passages | Repo discovery / trending (use `github_search`) | **2 credits / 10 results**, rounded up. Filters: `types`, `repos`, `doc_sources`, language/topic/stars. Mount-absence note applies. |
| Hacker News | `hackernews_search` | HN threads, comments, front page | General web | $0. Algolia + official feeds. Maintenance note: upstream repo archived 2026-02 — future Algolia changes land without repo signal. |
| Reddit (named subs) | `reddit_search` `[GAP-PASS]` | Practitioner chatter in given subreddits; archive depth beyond X's 7d window; body-text search | **First-move lane (demoted to gap-pass)**; global Reddit search; live official API; thread comments | $0 Arctic Shift archive (third-party, single maintainer). `query=` routing bug fixed 2026-09; keyword-search 422s are retryable (server load) and rate-limit headers are honored (verified 2026-09-13). Fallback: `web_search site:reddit.com`. |
| GitHub **repositories** | `github_search` | New/trending repos (created + stars proxy) | Code, issues, PRs, docs (use Firecrawl developer index) | $0. 10 req/min unauth; 30/min with token. Search API 1000-hit cap. Pinned API version supported until 2028-03-10. |
| arXiv preprints | `arxiv_search` | CS/AI primary preprints + PDF URLs; `id_list` direct lookup for cited-paper follow-ups | Paywalled publisher pages | $0. ~1 req / 3s polite. |
| Product Hunt launches | `producthunt_search` `[FRAGILE]` | Launches by **topic + date** | Keyword search (API cannot grep); **never a default lane** | Needs Developer Token. **Onboarding fragility**: issue #343 blocks new-token acquisition; if the token is ever lost, cut this row rather than ship unprovisionable. |
| RSS / lab blogs | `feed_search` | Newsletters, Substack/Medium, `ai-labs` / `tech-news` bundles | Ad-hoc web discovery | $0. ⚠ `ai-labs` bundle partially empty in probes (3/4 feeds) — verify liveness before relying on it in a coverage pass. |
| X / Twitter public posts (Grok) | `x_search` | Live posts, handles, topic synthesis | Exact operators, `public_metrics`, archive, write/DM | xAI login or `XAI_API_KEY`. Models: `grok-4.3` default; `grok-4.6` option; `reasoning_effort` up to `xhigh` (grok-4.6+). ⚠ Billing change **2026-09-21**: $5/1k posts + $10/1k profiles fetched (parent+quoted count) — replaces per-call; `high`+`volume`+`limit:30` can cost ~10× the old assumption. Capture: syndication free; Firecrawl capture spends credits. |
| X recent search (7d) | `x_api` `recent` `[NOT CONFIGURED]` | Exact operators, last 7 days, `public_metrics` | Grok synthesis; posts older than 7d | **`X_BEARER_TOKEN` not configured in this profile — not in the default mix.** Removal trigger: if the token is not provisioned by v2 ship, these rows are cut. ~$0.005/post; from 2026-09-21 per-resource billing, parent+quoted posts count. Default 10, max 100/page. |
| X full-archive search | `x_api` `archive` `[NOT CONFIGURED]` | Same operators, 2006+ | Grok synthesis; unentitled archive | Same token + billing note as `recent`. Query max 1024 chars. Archive `max_results` ceiling 500 (recent ≤100); bulk pulls bill more without `max_results:500`. |

### Fetch / extract / traverse

| Capability | Tool | Best for | Not for | Cost / limit (guidance) |
|---|---|---|---|---|
| Known-URL bodies (Exa) | `exa_search` `contents` | Pack summary/highlights/text for URLs you have; `subpages`/`extras` sub-options | Discovery | Contents bill **$1/1k per content type** — text+highlights co-request = double-billing. Limit 100 URLs (our clamp 20). |
| Known-URL bodies (Parallel) | `parallel_search` `extract` | Excerpts / full content for ≤20 URLs (V1 shape: `advanced_settings{excerpt_settings, full_content}`; top-level Beta shape is dead) | Discovery | Metered per extract. Stale `parallel-beta` header dropped 2026-09. |
| Tavily extract / map / crawl | `tavily_search` `extract` / `map` / `crawl` | Batch markdown; sitemap; Tavily crawl | Login walls | extract 1–2 cr / 5 successes, **cap 20 URLs** (50 → 400); map 1 cr (2 cr with `instructions`); crawl 2 cr / job; map honors `max_depth`/`limit` (dropped-params bug fixed 2026-09). Auth: `Authorization: Bearer` (body `api_key` is deprecated). |
| Site map (cheap recon) | `firecrawl_crawl` `map` | Shape of a public site before spending per page | Page bodies | ~1 credit. Limit up to 100000 URLs. Mount-absence note applies. |
| One public page | `firecrawl_crawl` `scrape` | Markdown/HTML/JSON/summary; JSON mode for structured extract; `profile{name,saveChanges}` + `parsers` (pdf fast/ocr, `maxPages`) | Login walls (no cookies) | **1 credit / page** (+4 for LLM-backed formats). JSON mode cheaper than agent for one known URL. |
| Many known URLs | `firecrawl_crawl` `batch` | Parallel scrape, max 100 URLs (our clamp; batch-100 documented as ours) | Unknown URL gather | 1 credit / page × URL count |
| Managed multi-page crawl | `firecrawl_crawl` `crawl` | Public docs sites with a **named page limit** | Behind-login; unbounded “get the whole site” | **1 credit / scraped page**. Default limit 20; our hard max 500 is our clamp (upstream default 10,000 with pre-flight credit check — 402 + limit-lowering retry). Always name `limit` in the plan. |
| LLM extract from known URL globs | `firecrawl_crawl` `extract` | `example.com/*` + prompt/schema | Unknown URLs (use agent) | Token/credit based; wait+cancel on timeout |
| Autonomous gather (URLs unknown) | `firecrawl_crawl` `agent` | “Find X wherever it lives” | One known URL (use scrape JSON) | Dynamic. Plan **must** name `max_credits` (default 100; our `.max(2500)` is our guard — upstream defaults to 2500 and accepts higher). |
| Interact with a prior scrape | `firecrawl_crawl` `interact` | Click/fill on a **public** scrape session | Behind-login (use `browser`) | **2–7 credits / browser-minute** (prompt 7/min, code-only 2/min), 1-min minimum. Keep `interact_timeout` tight. |
| Canonical X post(s) | `x_api` `lookup` `[NOT CONFIGURED]` | Ids or status URLs → text + `public_metrics` | Discovery | Token + 2026-09-21 billing note as the search rows. ~$0.005/post. Max 100 ids. `paid_partnership` field available. |
| X reply thread | `x_api` `thread` `[NOT CONFIGURED]` | `conversation_id` / status URL reply tree | Threads older than 7d without `archive` | Recent search under the hood. Same per-post cost. |
| X user profile | `x_api` `user` `[NOT CONFIGURED]` | Handle → followers, verified, description | Posts | ~$0.010/user (per-resource from 2026-09-21; Owned Reads $0.001/resource for own-data reads). |
| X user timeline | `x_api` `timeline` `[NOT CONFIGURED]` | Up to 3200 recent posts; `exclude` retweets/replies | Full archive of a user | ~$0.005/post. Default 10/page. |
| X volume counts | `x_api` `counts` `[NOT CONFIGURED]` | Bucketed hit counts, not posts | Post text | `window=recent` ~$0.005/req; `all` ~$0.010/req. `granularity` minute/hour/day. |
| Cited-answer synthesis | `parallel_search` Responses (`POST /v1/responses`) | Cited answers + structured outputs with a latency/cost dial | Bulk retrieval (use `search`) | `reasoning.effort`: low **$10/1k**, medium **$50/1k** (default), high **$250/1k** — `high` is a budgeted tier, never without an explicit budget. Effort-tiered; budget-gated per the deep-research skill's routing addendum. |
| Multi-hop research report | `parallel_search` `task` | Synthesized report with processor tiers | First-pass lookup | lite $0.005 · base $0.01 · core $0.025 · **core2x $0.05** · pro $0.10 · ultra $0.30 · ultra8x up to $2.40; nine `-fast` variants exist at same price but vendor steers away. **Cannot cancel.** Never start above `base` without a stated budget. |

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
| Wikipedia — full search / revisions / entities | MediaWiki API + Wikidata | $0 · `action=query` search, revision history, langlinks; Wikidata SPARQL for provenance dating |
| Public social (not X) | Bluesky XRPC | $0 |
| Expert Q&A (vote-signaled answers) | Stack Exchange API v2.3 | $0 · 300 req/day per IP keyless — **free app key recommended**, shared-IP quota burns |
| OSS versions / dependency graphs / advisories | deps.dev | $0 · Cargo/Go/Maven/npm/NuGet/PyPI, OSV advisories |
| News-event coverage volume | GDELT 2.0 DOC + Events | $0 keyless · 15-min cadence · **coverage-pass only, watch-tier** |

## Construction rules

1. The tables above are the map. List every row that **could** answer, then choose. Do not default to `web_search` or Tavily because they are listed first. Do not skip `x_api` / `x_search` because they are social. `x_api` rows tagged `[NOT CONFIGURED]` are out of the default mix (removal trigger in the row); `[GAP-PASS]`/watch-tier rows are demoted lanes, not defaults.
2. **User-provided corpus → `grep`/`read` first** — local documents are a lane before any retrieval tool (a routing rule, not a tool).
3. Corpus is a fact in the row (`Best for` / `Not for`), not a separate ladder.
4. One known URL → `read` / Jina / scrape JSON / `x_api` `lookup`. Unknown URLs → search or Firecrawl agent (with ceiling). Site shape unknown → `map` before `crawl`.
5. Behind-login → `browser`. Firecrawl has no cookies.
6. Name ceilings from the row: Firecrawl `limit` / `max_credits`, Parallel processor, `x_api` `max_results`. Parallel `pro`+ / Responses `high`, Tavily `research`, and Firecrawl `agent` / large crawls need an explicit budget.
