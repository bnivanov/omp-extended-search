# firecrawl_search

Direct access to Firecrawl's `POST https://api.firecrawl.dev/v2/search` endpoint. The extension is the **advanced/direct Firecrawl lane**: omp's built-in `web_search` remains the everyday choice.

Since omp 17.0.9, native `web_search` can itself use Firecrawl, including limited keyless access, **only when Firecrawl is explicitly selected in `providers.webSearchOrder`**. The automatic provider chain remains credential-gated, and this installer does not set provider order. That native lane overlaps the basic `query` + `limit` case. `xd://firecrawl_search` remains useful when you need to choose Firecrawl explicitly or use its web/news/images sources, GitHub/research/PDF categories, domain/date/location filters, highlights and scrape controls, or raw response metadata.

## Credentials

Credential resolution order:

1. The omp session/provider Firecrawl credential.
2. `FIRECRAWL_API_KEY`.
3. Keyless Firecrawl access.

Keyless search is limited; either credential can provide higher limits. The tool sends `Authorization: Bearer …` when either the stored session/provider credential or `FIRECRAWL_API_KEY` is selected, without exposing the credential.

## July 22, 2026 highlights upgrade

Firecrawl's July 22, 2026 Search upgrade changed the relevance model without changing the API. Existing searches now receive query-relevant highlights by default: a web result's `description` or a news result's `snippet` is a focused, Markdown-capable excerpt rather than merely the search engine's generic text. If Firecrawl cannot retrieve a page, it can fall back to the ordinary snippet while allowing the other results to complete. Image results are unchanged.

Firecrawl reports **94.7% on SimpleQA** and **10x fewer tokens** than a traditional search-then-scrape workflow for this upgrade; those are Firecrawl's claims, not independent benchmarks.

## Parameters

User-facing keys are `snake_case`; the tool translates them to Firecrawl's `camelCase` payload keys.

| Input | Default | Meaning / Firecrawl payload |
|---|---|---|
| `query` | required | Search query, at most 500 characters. |
| `limit` | `10` | Results **per source**, 1–100. |
| `sources` | `["web"]` | Any of `web`, `news`, `images`. Sent as `sources`. |
| `categories` | omitted | Any of `github`, `research`, `pdf`. Sent as `categories`. |
| `include_domains` | omitted | Hostnames to include; sent as `includeDomains`. Mutually exclusive with `exclude_domains`. |
| `exclude_domains` | omitted | Hostnames to exclude; sent as `excludeDomains`. Mutually exclusive with `include_domains`. |
| `recency` | omitted | Convenience value `hour`, `day`, `week`, `month`, or `year`; maps to `tbs=qdr:h`, `qdr:d`, `qdr:w`, `qdr:m`, or `qdr:y`. |
| `tbs` | omitted | Raw Firecrawl/Google time filter, including `qdr:*`, `sbd:1`, or a custom `cdr` date range. It applies to web search only. |
| `location` | omitted | Free-form location bias. Firecrawl recommends pairing it with `country`. |
| `country` | `US` upstream | Two-letter country bias; omitted by the tool unless supplied. |
| `highlights` | `true` | Enables query-relevant web descriptions and news snippets. Images are unaffected. |
| `content` | `none` | `none`, `markdown`, `summary`, or `links`. Any value other than `none` requests that full-page scrape format through `scrapeOptions.formats`. |
| `only_main_content` | omitted | Optional `scrapeOptions.onlyMainContent`; Firecrawl applies its upstream default. Used only with scraped content. |
| `max_age_ms` | omitted | Optional cache age in milliseconds; maps to `scrapeOptions.maxAge`. |
| `timeout_ms` | `60000` | Whole search timeout in milliseconds; maps to top-level `timeout`. |
| `scrape_timeout_ms` | omitted | Optional per-page scrape timeout in milliseconds; maps to `scrapeOptions.timeout`. Firecrawl's upstream default is 60 seconds and accepted range is 1–300 seconds. |
| `ignore_invalid_urls` | omitted | Maps to top-level `ignoreInvalidURLs`; Firecrawl applies its upstream default when omitted. Controls whether invalid result URLs are skipped. |

`recency` is the convenient choice for common windows; use `tbs` for Firecrawl's raw time syntax. They are mutually exclusive. Categories select Firecrawl vertical indexes, while sources select result kinds. Do not assume that a `limit` of 10 means 10 total results: with `sources: ["web", "news"]`, it can return up to 10 of each.

## Highlights versus full scrape content

The default is deliberately **highlights-only metadata**:

```json
{"query":"agent memory","highlights":true,"content":"none"}
```

That returns URLs, titles, focused descriptions/snippets, and other search metadata without asking Firecrawl to scrape every result page. This is usually the best agent input: focused text, lower latency, and no per-page scrape charge.

Set `content` to `markdown`, `summary`, or `links` only when the result pages themselves are required. That builds `scrapeOptions.formats` and may add the requested field to each successfully scraped item. `only_main_content`, `max_age_ms`, and `scrape_timeout_ms` tune those scrapes. With `content: "none"`, the tool emits no `scrapeOptions` and ignores those three scrape-only inputs. A page scrape can fail while the rest of the search succeeds; keep the item's error instead of discarding the whole response.

## Result shape

The visible tool output renders grouped Web, News, and Images sections and shows `warning`, `id`, `creditsUsed`, requested content, and partial item errors when present. The complete Firecrawl response remains available as `details.rawResponse`, preserving this upstream shape:

```json
{
  "success": true,
  "data": {
    "web": [{"url":"…","title":"…","description":"…"}],
    "news": [{"url":"…","title":"…","snippet":"…"}],
    "images": [{"url":"…","title":"…"}]
  },
  "warning": "…",
  "id": "…",
  "creditsUsed": 4
}
```

Only requested/non-empty source groups may be present. `warning`, `id`, and `creditsUsed` are preserved when Firecrawl returns them. Individual result entries may carry an error (for example, a scrape failure) while sibling entries remain usable. `details.request` also records the camelCase API body and whether authentication was keyless or `Bearer [REDACTED]`; it never exposes the key.

There is **no pagination**: the endpoint exposes no cursor, page, offset, or next token. Choose a bounded `limit` and make another explicitly different query if needed.

## Cost and latency

- `limit` is per source. Selecting two sources can approximately double returned items and search credit use; three can triple them.
- Firecrawl currently documents search at 2 credits per 10 results, rounded up **for each source**.
- `content: "none"` avoids full-page scraping. Optional scraped `markdown`, `summary`, or `links` adds per-result scrape credits and network latency; PDFs can cost per PDF page, and premium scrape features may cost more.
- Keyless mode is intentionally limited. A `FIRECRAWL_API_KEY` raises limits but does not make scraping free.
- Search `timeout_ms` and per-page `scrape_timeout_ms` are separate. A larger timeout can improve completion but also increases worst-case latency.

## Invocation

These are exact xdev invocations: `read` the device for its live schema, then `write` JSON to the same **`xd://firecrawl_search`** path. There is no `xdi://` form and `firecrawl_search` is not a top-level function call.

### Focused news highlights, keyless or keyed

```text
read  xd://firecrawl_search

write xd://firecrawl_search
{"query":"AI agent memory","sources":["news"],"recency":"week","limit":5}
```

### Firecrawl category and domain filters

```text
write xd://firecrawl_search
{"query":"Model Context Protocol servers","categories":["github"],"include_domains":["github.com"],"limit":10}
```

### Multiple sources with optional page content

```text
write xd://firecrawl_search
{"query":"agent evaluation benchmark","sources":["web","news"],"categories":["research"],"content":"summary","only_main_content":true,"scrape_timeout_ms":30000,"limit":5}
```

The last request allows up to five results **from each source** and asks Firecrawl to scrape a summary for each result, so plan for both search credits and additional scrape cost/latency. For an ordinary lookup with no Firecrawl-specific control, use omp's built-in `web_search` instead.
