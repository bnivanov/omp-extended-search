# Keyless & Free Primary API Recipes

All recipes below are free, utilize existing environment keys or keyless polite pools, and work directly via OMP's `read(URL)` or simple fetch.

---

## 1. OpenAlex — Scholarly Works & Citation Graph
- **Endpoint:** `GET https://api.openalex.org/works?search=<QUERY>&per-page=5`
- **Filters:** `filter=publication_year:2024-2026,type:article` · `sort=cited_by_count:desc`
- **Output:** Title, publication year, cited-by count, DOI, open-access PDF URL.
- **Quota:** 100,000 requests/day (Polite pool).

## 2. CORE — Global Open-Access Research Repository
- **Endpoint:** `GET https://api.core.ac.uk/v3/search/works?q=<QUERY>&limit=5`
- **Auth Header:** `Authorization: Bearer <CORE_API_KEY>` (from `~/.omp/agent/.env`).
- **Output:** Full metadata, research papers, theses, and direct PDF download links across global institutional repositories.
- **Verified Latency:** ~1.2s.

## 3. PubMed E-utilities — Biomedical Primary Sources
- **Search:** `GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<QUERY>&retmax=5&retmode=json`
- **Summary:** `GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=<ID_LIST>&retmode=json`
- **Fetch Abstract:** `GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=<ID_LIST>&rettype=abstract&retmode=text`
- **Quota:** 1 request / 3s without key.

## 4. Crossref REST API — DOI Metadata & Scholarly Index
- **Endpoint:** `GET https://api.crossref.org/works?query=<QUERY>&rows=5`
- **Headers:** `User-Agent: OMP-DeepResearch/1.0 (mailto:agentlab@omp.local)` (Polite Pool).
- **Output:** Official publication dates, journals, DOIs, publisher metadata.

## 5. FRED — Federal Reserve Economic Data (Macroeconomics)
- **Endpoint:** `GET https://api.stlouisfed.org/fred/series/observations?series_id=<SERIES_ID>&api_key=<FRED_API_KEY>&file_type=json&limit=5&sort_order=desc`
- **Series IDs:** `CPIAUCSL` (CPI / Inflation), `FEDFUNDS` (Federal Funds Rate), `GDP` (Gross Domestic Product), `UNRATE` (Unemployment Rate).
- **Auth:** `FRED_API_KEY` (from `~/.omp/agent/.env`).
- **Verified Latency:** ~500ms.

## 6. Finnhub — Live Equities & Corporate Intelligence
- **Quote Endpoint:** `GET https://finnhub.io/api/v1/quote?symbol=<TICKER>&token=<FINNHUB_API_KEY>`
- **Financials Endpoint:** `GET https://finnhub.io/api/v1/stock/metric?symbol=<TICKER>&metric=all&token=<FINNHUB_API_KEY>`
- **Auth:** `FINNHUB_API_KEY` (from `~/.omp/agent/.env`).
- **Verified Latency:** ~370ms.

## 7. SEC EDGAR — 10-K, 10-Q, 8-K Filings
- **Endpoint:** `GET https://efts.sec.gov/LATEST/search-index?q=<QUERY>&forms=8-K,10-K,10-Q`
- **CRITICAL:** **Must provide descriptive User-Agent** (e.g. `User-Agent: ResearchAgent research@example.com`). Plain default UA returns 403.
- **Rate Limit:** 10 requests / second.

## 8. Polymarket Gamma API — Real-Time Prediction Markets & Consensus
- **Endpoint:** `GET https://gamma-api.polymarket.com/events?query=<QUERY>&limit=5&active=true&closed=false`
- **Auth:** $0.00 Keyless Public REST API.
- **Output:** Live market pricing, probabilistic outcomes, trading volume on geopolitical/tech/economic events.
- **Verified Latency:** ~270ms.

## 9. Jina Reader — Instant Web-to-Markdown Extraction
- **Endpoint:** `GET https://r.jina.ai/<TARGET_URL>`
- **Headers:** `Accept: text/plain`
- **Auth:** $0.00 Keyless.
- **Output:** Clean, boilerplate-free Markdown extracted directly from any live webpage without browser overhead.

## 10. Wikipedia REST API — Fast Entity Summaries
- **Endpoint:** `GET https://en.wikipedia.org/api/rest_v1/page/summary/<PAGE_TITLE>`
- **Headers:** `User-Agent: OMP-DeepResearch/1.0 (mailto:agentlab@omp.local)`
- **Output:** Disambiguated title, summary extract, canonical description.
- **Verified Latency:** ~340ms.

## 11. Bluesky XRPC — Public Social Discourse
- **Endpoint:** `GET https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=<QUERY>&limit=10`
- **Requirements:** Standard browser User-Agent. Returns full post text, author handle, like/repost counts.

## 12. Wayback Machine — Dead-Link Rescue & Page History
- **Availability Check:** `GET https://archive.org/wayback/available?url=<URL>`
- **CDX Index:** `GET https://web.archive.org/cdx/search/cdx?url=<DOMAIN_OR_URL>&output=json&limit=5&fl=timestamp,original,statuscode`
