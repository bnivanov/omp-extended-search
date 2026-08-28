# Domain candidate matrix

Not a first-choice ladder. For each domain, these are **candidates** the plan may pick from. The visible plan still lists Chosen **and** Rejected.

Full knobs/costs: `capability-catalog.md`.

| Domain | Candidates | Typical rejects |
|---|---|---|
| Quick fact / definition | Wikipedia REST; `web_search`; Tavily basic; Exa `answer` | Parallel task; Firecrawl crawl/agent |
| Entity / company background | Wikipedia; `web_search`; Exa neural + company category | X as primary; Product Hunt keyword |
| Breaking / topic news | Tavily `topic=news`; Firecrawl `sources=["news"]`; `feed_search` tech-news | Exa deep; GitHub |
| Semantic / “pages like this” | Exa neural/deep; Parallel `search` | Tavily keyword-only |
| Product / pricing comparison | Exa deep **or** Parallel search + extract; Tavily advanced; Firecrawl scrape of named vendor URLs | Unbounded crawl; Parallel ultra as first move |
| Academic / preprints | arXiv (`$0`); OpenAlex/Crossref/CORE; Firecrawl `papers` / `related` | `categories=["research"]` website filter; Parallel task for a DOI you already have |
| Biomedical | PubMed E-utilities; OpenAlex; Firecrawl papers | HN |
| Code bug / “where was this fixed” | Firecrawl `developer` (issues, PRs, READMEs, docs) | `github_search` (repos only) |
| New / trending repos | `github_search` (created + stars) | Developer index |
| Library / API contract | Firecrawl `developer` docs; `read` known docs URL; Jina | Repo search |
| HN community | `hackernews_search` | `web_search site:news.ycombinator.com` as first move |
| Reddit practitioner chatter | `reddit_search` named subs | Global Reddit; Firecrawl of reddit.com |
| X / Twitter | `x_search` | Tavily/Exa as X substitute |
| Product Hunt launches | `producthunt_search` topic + date | Keyword grep (API cannot) |
| RSS / lab blogs | `feed_search` bundles or URL | Ad-hoc web crawl |
| Macro / Fed | FRED | News synthesis as primary data |
| Equities / earnings | Finnhub | Firecrawl IR sites first |
| Filings | SEC EDGAR EFTS | News rewrite of 8-K |
| Prediction markets | Polymarket Gamma | Twitter as probability |
| Known public URL body | `read` / Jina / Firecrawl `scrape` (JSON if structured) | Firecrawl `agent` |
| Many known public URLs | Firecrawl `batch`; Tavily extract; Parallel extract | Sequential scrape |
| Site shape unknown | Firecrawl `map` then selective scrape | Crawl with default 20 “to see” |
| Public docs site, many pages | Firecrawl `crawl` with **named `limit`** | Agent; browser |
| Unknown URLs, “find it” | Firecrawl `agent` + `max_credits` | Scrape of a guessed URL |
| JS / login wall | `browser` | Firecrawl (no cookies) |
| Dead / historical | Wayback CDX | Live scrape |
| Multi-hop synthesized report | Parallel `task` (lite/base/core; pro+ only with budget) | Starting at ultra; Exa Agent if not wired here |
| Public social not X | Bluesky XRPC | X tool |
