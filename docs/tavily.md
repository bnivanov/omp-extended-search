# Tavily Search Tool (`tavily_search`)

Drop-in Tavily AI web access for Oh My Pi (omp) — Search, Extract, Crawl, Map, and live Account Quota inspection.

## Capabilities

- **Search (`operation=search`, default)**: AI-grounded search with optional synthesized answers, raw content extraction, image links, domain filtering, and time filtering (`days`).
  - `search_depth: "basic"` (1 credit, fast ~1s)
  - `search_depth: "advanced"` (2 credits, deeper analysis)
  - `topic: "general" | "news" | "finance"`
- **Extract (`operation=extract`)**: Direct LLM-ready markdown/text extraction for a list of URLs.
- **Map (`operation=map`)**: Fast sitemap graph discovery for a website root.
- **Crawl (`operation=crawl`)**: Multi-page graph-based crawl and extract.
- **Usage (`operation=usage`)**: Live query of your plan, remaining credits, and per-endpoint usage.

## Authentication

First match wins:
1. OMP session credentials for provider `tavily` (`/login` or broker)
2. `TAVILY_API_KEY` environment variable

## Usage Examples

### Search with Direct Answer
```json
{
  "query": "latest breakthroughs in multimodal AI agents 2026",
  "search_depth": "advanced",
  "topic": "general",
  "include_answer": true,
  "max_results": 5
}
```

### News Search with Time Window
```json
{
  "query": "NVIDIA earnings announcement",
  "topic": "finance",
  "days": 7,
  "max_results": 5
}
```

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

### Check Remaining Quota & Balances
```json
{
  "operation": "usage"
}
```
