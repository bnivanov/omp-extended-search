# Tavily Search Tool (`tavily_search`)

Drop-in Tavily AI web access for Oh My Pi (omp) — Search, Extract, Crawl, Map, agentic Research reports, and live Account Quota inspection.

## Capabilities

- **Search (`operation=search`, default)**: AI-grounded search with synthesized answers, raw content extraction, image links, domain/language filtering, and date filtering.
  - `search_depth: "basic"` (1 credit, fast ~1s) — basic now returns reranked chunks; `chunks_per_source` (1–3) applies, content joined by `[...]`
  - `search_depth: "advanced"` (2 credits, deeper analysis)
  - `topic: "general" | "news" | "finance"`
  - Date window: `time_range: "day" | "week" | "month" | "year"` or `start_date` / `end_date` (ISO `YYYY-MM-DD`) — the undocumented `days` param is gone and no longer sent
  - Aug-2026 params: `include_domains_mode` (`filter`|`boost`), `language` + `filter_by_language` (ISO 639-1; soft boost by default, strict filter opt-in), `safe_search`
  - `include_answer`: `true`/`false` or grade `basic|advanced` (default `true`)
  - `include_raw_content`: `true`/`false` or grade `markdown|text` (default `false`)
  - ⚠ `auto_parameters: true` is **cost-opaque** — Tavily may silently upgrade the query to `advanced` depth (2 credits)
- **Extract (`operation=extract`)**: direct LLM-ready markdown/text extraction for a list of URLs — **max 20 URLs** (upstream cap; our schema clamps there; sending 50 was a 400)
- **Map (`operation=map`)**: fast sitemap graph discovery — honors `max_depth` (1–5, default 1) and `limit` (1–50); the dropped-params bug was fixed 2026-09. `instructions` doubles mapping cost (2 cr)
- **Crawl (`operation=crawl`)**: multi-page graph-based crawl and extract (2 credits/job)
- **Research (`operation=research`, poll via `research_status`)**: agentic cited research report. Dynamic credit cost — mini 4–110, pro 15–250 — so an explicit `max_credits` budget acknowledgment is **required** (client-side guard: mini ≥4, pro ≥15; it is not sent to the API)
- **Usage (`operation=usage`)**: live query of your plan, remaining credits, and per-endpoint usage (search/extract/crawl/map/research)

## Authentication

Every call authenticates via `Authorization: Bearer` — the body `api_key` property is deprecated upstream and removed from this tool (dev-tier keys reject body-auth). First match wins:
1. OMP session credentials for provider `tavily` (`/login` or broker)
2. `TAVILY_API_KEY` environment variable

## Usage Examples

### Search with Direct Answer
```json
{
  "query": "latest breakthroughs in multimodal AI agents 2026",
  "search_depth": "advanced",
  "topic": "general",
  "include_answer": "advanced",
  "max_results": 5
}
```

### News Search with Time Window
```json
{
  "query": "NVIDIA earnings announcement",
  "topic": "finance",
  "time_range": "week",
  "max_results": 5
}
```

Absolute window instead: `{ "start_date": "2026-09-01", "end_date": "2026-09-13" }`.

### Multi-URL Content Extraction
```json
{
  "operation": "extract",
  "urls": [
    "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    "https://docs.tavily.com/documentation/api-reference/endpoint/extract"
  ]
}
```
(max 20 URLs per call)

### Agentic Research Report
```json
{
  "operation": "research",
  "query": "state of open-weight LLMs vs closed APIs in 2026",
  "model": "mini",
  "max_credits": 20
}
```
Then poll: `{ "operation": "research_status", "research_id": "<request_id>" }`.

### Check Remaining Quota & Balances
```json
{
  "operation": "usage"
}
```
