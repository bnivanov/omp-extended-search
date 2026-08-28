# firecrawl_search

Direct access to Firecrawl Search v2 plus the Research and Developer indexes. The extension is the **advanced/direct Firecrawl lane**: omp's built-in `web_search` remains the everyday choice.

Since omp 17.0.9, native `web_search` can itself use Firecrawl, including limited keyless access, **only when Firecrawl is explicitly selected in `providers.webSearchOrder`**. The automatic provider chain remains credential-gated, and this installer does not set provider order. That native lane overlaps the basic `query` + `limit` SERP case. `xd://firecrawl_search` remains useful when you need to choose Firecrawl explicitly, pick an index (`papers` / `paper` / `related` / `developer`), or use web/news/images sources, GitHub/research/PDF categories, domain/date/location filters, highlights and scrape controls, or raw response metadata.

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
| `operation` | `search` | `search` (SERP), `papers` (paper index), `paper` (inspect/read one paper), `related` (citation graph), `developer` (issues/PRs/READMEs/docs). |
| `query` | required for search/papers/developer | Search query. SERP max 500 characters; papers/developer allow longer. Optional paper-read question; related intent fallback. |
| `limit` | `10` | SERP results **per source**, 1–100. |
| `k` | `10` | Index result count: papers/related max 500; developer max 100; paper passages max 50. |
| `sources` | `["web"]` | Any of `web`, `news`, `images`. Sent as `sources`. SERP only. |
| `categories` | omitted | Any of `github`, `developer`, `research`, `pdf`. `github` aliases to `developer`. `developer` cannot mix with other SERP categories — use `operation=developer` for the developer index. |
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

## Pagination and truncation

There is **no pagination**: the endpoint exposes no cursor, page, offset, or next token. `details.pagination` is still attached for a uniform shape across tools:

| Field | Value for `firecrawl_search` |
|---|---|
| `page` | Always `1`. |
| `per_page` | The effective per-source `limit`. |
| `returned` | **Aggregate** count across the requested sources (not comparable to `limit`). |
| `per_source` | Counts broken out by source name. |
| `truncated_sources` | Source names that hit the per-source limit (the signal that more may exist). |
| `has_more` | Always `false` — this tool does not emit a meaningful `has_more`; use `truncated_sources` instead. |
| `continuation_supported` | Always `false`. |

`continuation_supported: false` means the tool has **no page/cursor parameter at all**. Raise `limit` or narrow the query; do not expect a follow-up page request. The trailing human-readable line in the text output mirrors this, e.g. `Showing 12 results total (web=7, news=5; per-source limit 10) — truncated at the per-source limit for: web. This tool has no pagination; raise limit or narrow the query to see more.`

## Resilience

Transport and HTTP failures use bounded exponential backoff with jitter (base 500 ms, cap 8 s, up to 3 attempts = 1 try + 2 retries). `Retry-After` is honored when present, but only when the delay still fits inside the remaining request deadline; otherwise the call fails immediately rather than overshooting the budget. The tool's own `timeout_ms` (plus a small grace window) aborts an in-flight attempt **and** interrupts a retry sleep.

Retryable statuses for this billed `POST /v2/search` are **408 / 425 / 429 / 502 / 503 / 504**, plus pre-response transport errors. **`500` is deliberately excluded**: the server may already have accepted and billed the search. Aborts are normalized to `AbortError` (including timeouts surfaced that way to callers).

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

## Research and Developer indexes

These are **not** the SERP `categories: ["research"]` website filter. They hit Firecrawl's paper and developer indexes.

| `operation` | Endpoint | Required |
|---|---|---|
| `papers` | `GET /v2/search/index/papers` | `query` |
| `paper` | `GET /v2/search/index/papers/{paper_id}` | `paper_id` |
| `related` | `GET /v2/search/index/papers/{paper_id}/related` | `paper_id` plus `intent` or `query` |
| `developer` | `GET /v2/search/index/developer` | `query` |

| Input | Used by | Meaning |
|---|---|---|
| `paper_id` | paper, related | Canonical `paperId` or `primaryId` such as `arxiv:2105.05233`. |
| `authors`, `paper_categories`, `from`, `to` | papers | Author substring, category, inclusive `YYYY-MM-DD` date bounds. |
| `intent`, `related_mode`, `rerank`, `anchors` | related | Ranking intent; `similar` / `citers` / `references`; extra rerank; extra seed ids. |
| `types`, `repos`, `doc_sources`, `skills`, `passages` | developer | Result kinds (`doc`/`issue`/`pull_request`/`readme`); repo slugs; doc source ids (max 20); `skills: "only"`; passages per result (1–5). |
| `language`, `topic`, `license`, `min_stars`, `max_stars`, `archived`, `fork` | developer | Repository filters. |

```text
write xd://firecrawl_search
{"operation":"papers","query":"agent memory","k":10,"from":"2024-01-01"}

write xd://firecrawl_search
{"operation":"developer","query":"firecrawl scrape interact","repos":["firecrawl/firecrawl"],"types":["doc","readme"]}
```

---

# firecrawl_crawl

Sibling tool at **`xd://firecrawl_crawl`** for Firecrawl endpoints that `firecrawl_search` does not wire: **map**, **scrape**, **crawl**, **batch scrape**, **extract**, **agent**, **interact**, plus status/cancel.

> **Public pages only.** Firecrawl sends no cookies or session credentials, so `firecrawl_crawl` reaches **PUBLIC pages only**. Behind-login traversal needs the `xd://browser` device. Public JS pages can `scrape` then `interact`.

Credentials match `firecrawl_search`: omp session/provider Firecrawl credential, then `FIRECRAWL_API_KEY`, then limited keyless mode. Optional `FIRECRAWL_BASE_URL` overrides the default `https://api.firecrawl.dev`.

## Operations

| `operation` | Endpoint | What it does |
|---|---|---|
| `map` | `POST /v2/map` | Discover URLs for a site (cheap shape check). |
| `scrape` | `POST /v2/scrape` | Fetch one page in the requested formats (incl. JSON mode). |
| `crawl` | `POST /v2/crawl` (+ poll) | Start a managed multi-page crawl; wait or return a job id. |
| `status` | `GET /v2/crawl/{job_id}` | Poll a crawl job and accumulate pages via `next` cursors. |
| `cancel` | `DELETE /v2/crawl/{job_id}` | Cancel a running crawl job. |
| `batch` | `POST /v2/batch/scrape` | Scrape many known URLs in one job (max 100). |
| `batch_status` / `batch_cancel` | `GET` / `DELETE /v2/batch/scrape/{job_id}` | Poll or cancel a batch job. |
| `extract` | `POST /v2/extract` | LLM extract from known URLs (wildcards allowed). Prefer agent when URLs are unknown. |
| `extract_status` / `extract_cancel` | `GET` / `DELETE /v2/extract/{job_id}` | Poll or cancel extract. |
| `agent` | `POST /v2/agent` | Autonomous gather when URLs are unknown. Credit ceiling via `max_credits`. |
| `agent_status` / `agent_cancel` | `GET` / `DELETE /v2/agent/{job_id}` | Poll or cancel agent. Cancelled jobs report `failed`. |
| `interact` | `POST /v2/scrape/{scrape_id}/interact` | Prompt or Playwright/code against a prior scrape session. |
| `interact_stop` | `DELETE /v2/scrape/{scrape_id}/interact` | Stop an interact session. |

User-facing keys are `snake_case`; the tool translates them to Firecrawl's `camelCase` payload keys.

**Extractor pick:** scrape JSON mode for one known URL; agent when URLs are unknown; extract only when you already have URL globs. Interact is for a live scrape session, not a substitute for `xd://browser` behind login.

## Shared / common parameters

| Input | Default | Meaning |
|---|---|---|
| `operation` | required | One of the operations in the table above. |
| `url` | required for map/scrape/crawl | Target URL. |
| `urls` | required for batch/extract | URL list (max 100). Optional for agent. |
| `job_id` | required for *status / *cancel | Job id from a prior start. |
| `scrape_id` | required for interact / interact_stop | Scrape id from a prior `scrape` (shown in scrape output). |
| `limit` | see per-op | Map: max URLs (1–100000). Crawl: max pages (default **20**, hard max **500**). Status: max pages to accumulate when following `next`. |
| `wait` | `true` | Wait for crawl/batch/extract/agent completion. When false, return `job_id` immediately. |
| `poll_timeout_ms` | **300000** (5 min) | Max milliseconds to poll when `wait` is true (clamped 1000–3_600_000). |
| `timeout_ms` | `60000` (scrape) | Scrape request timeout in ms (1000–300000). Map and job-start use a 60s client timeout internally. |
| `prompt` | — | extract/agent natural-language task, or interact prompt (mutually exclusive with `code`). |
| `schema` | — | extract/agent JSON schema. |

## `map`

Discover URLs under a site without scraping page bodies.

| Input | Default | Meaning / payload |
|---|---|---|
| `url` | required | Start URL. |
| `search` | omitted | Optional relevance query to order discovered URLs. |
| `limit` | omitted (upstream decides; tool clamps 1–100000 when set) | Max URLs to return. |
| `include_subdomains` | omitted (Firecrawl default true) | Include subdomains; sent as `includeSubdomains`. |
| `sitemap` | omitted | `skip` \| `include` \| `only`. |

`details.pagination` for map: `{ page: 1, per_page, returned, has_more: false, upstream_total }`. There is no cursor to continue — raise `limit` if you need more URLs.

**Verified live while building the tool:** `map` against `https://docs.firecrawl.dev` with `limit: 5` returned 5 URLs.

## `scrape`

Fetch a single page.

| Input | Default | Meaning / payload |
|---|---|---|
| `url` | required | Page URL. |
| `formats` | `["markdown"]` | Format names: `markdown`, `html`, `rawHtml`, `links`, `summary`, `json`, `images`, `branding`, `product`. `json` becomes `{ type: "json", prompt, schema }` when `json_prompt` / `json_schema` are set. |
| `only_main_content` | `true` | Omit page chrome; sent as `onlyMainContent`. |
| `max_age_ms` | omitted | Cache age in ms; sent as `maxAge`. |
| `timeout_ms` | `60000` | Request timeout (1000–300000); sent as `timeout`. |
| `wait_for` | omitted | Extra wait in ms before capture; sent as `waitFor`. |
| `mobile` | omitted | Emulate a mobile device. |
| `json_prompt` / `json_schema` | omitted | JSON-mode prompt and schema when `formats` includes `json`. |
| `actions` | omitted | Pre-capture browser actions (`wait`, `click`, `write`, `press`, `scroll`, `screenshot`, `scrape`, `executeJavascript`, `pdf`). |
| `include_tags` | omitted | HTML tags to include; sent as `includeTags`. |
| `exclude_tags` | omitted | HTML tags to exclude; sent as `excludeTags`. |

Text output shows title, URL, scrape id (when present), status code, json/markdown/summary/html/rawHtml (quoted, truncated in the visible text with full content in `details.rawResponse`), and up to 30 links when present. A scrape id is required for later `interact`. Scrape does not attach a pagination block.

**Verified live while building the tool:** `scrape` of `https://example.com` returned markdown with status 200.

## `crawl`

Start a managed multi-page crawl. Default `wait: true` polls until the job is terminal (or the poll budget expires); `wait: false` returns the job id immediately for later `status` / `cancel`.

| Input | Default | Meaning / payload |
|---|---|---|
| `url` | required | Crawl start URL. |
| `limit` | **20** | Max pages to crawl; hard max **500** (validation rejects higher). |
| `max_discovery_depth` | omitted | Max discovery depth from the start URL; sent as `maxDiscoveryDepth`. |
| `include_paths` | omitted | Pathname regex patterns to include; sent as `includePaths`. |
| `exclude_paths` | omitted | Pathname regex patterns to exclude; sent as `excludePaths`. |
| `allow_external_links` | omitted (false upstream) | Follow external links; sent as `allowExternalLinks`. |
| `crawl_entire_domain` | omitted (false upstream) | Follow sibling/parent internal links, not only children; sent as `crawlEntireDomain`. |
| `sitemap` | — | Not a crawl body field on this tool (map-only). |
| `scrape_options` | see below | Per-page scrape options object. |
| `scrape_options.formats` | `["markdown"]` | Formats for each crawled page. |
| `scrape_options.only_main_content` | `true` | Main-content-only scrapes inside the crawl. |
| `wait` | `true` | When `true`, poll until completed (or fail/cancel). When `false`, return `job_id` immediately. |
| `poll_timeout_ms` | **300000** (5 min) | Max milliseconds to poll when `wait` is true (clamped 1000–3_600_000). |

### Wait / poll semantics

With `wait: true` (default):

1. `POST /v2/crawl` starts the job (**never retried** — job creation is not idempotent and a retry could start a second billed run).
2. The tool polls `GET /v2/crawl/{job_id}` every ~2 s until status is `completed`, `failed`, or `cancelled`, or until `poll_timeout_ms` elapses.
3. On `completed`, it follows status `next` cursors and accumulates pages up to `limit`, then returns them with pagination metadata.
4. On `failed` / upstream `cancelled`, it errors with the job detail.

With `wait: false`, the text output gives the job id and reminds you to call `status` / `cancel`; `details.pagination` is `{ page: 1, per_page: limit, returned: 0, has_more: true, continuation_supported: true }`.

### `next`-cursor accumulation

Both the wait path and `operation: "status"` call the same collector: seed from the current status payload, then `GET` each `next` URL until cursors are exhausted or the page limit is reached. Accumulation is hard-capped at the effective limit (never above 500) so a runaway cursor cannot grow without bound.

`details.pagination` after accumulation:

| Field | Meaning |
|---|---|
| `page` | Number of status/result pages consumed (≥ 1). |
| `per_page` | Effective page limit used as the accumulator cap. |
| `returned` | Pages actually accumulated. |
| `upstream_total` | Firecrawl's `total` when present. |
| `has_more` | `true` when upstream still had a `next` cursor but the accumulator hit the limit. |
| `continuation_supported` | `true` only when `has_more` is true (further pages exist via status/`next`). |

A trailing human-readable line is appended, e.g. `Showing 20 of 48 (page 2); more available — follow next cursor or request status again`.

### Cancel on poll timeout or abort

Firecrawl **does** expose job cancellation (`DELETE /v2/crawl/{id}`), unlike Parallel. If a waiting crawl hits `poll_timeout_ms` or the abort signal fires (and on other wait-path failures), the tool issues a real DELETE cancel (best-effort, 5 s timeout of its own) before returning the error. The structured result includes `details.cancellation`:

```json
{
  "attempted": true,
  "jobId": "…",
  "ok": true,
  "response": { }
}
```

or `ok: false` with `error` when the cancel itself failed. The visible error text also notes whether cancellation succeeded.

## `status`

| Input | Default | Meaning |
|---|---|---|
| `job_id` | required | Crawl job id. |
| `limit` | hard max 500 | Max pages to pull while following `next`. |

Fetches current status, accumulates pages the same way as a finished wait, and renders job id, status, progress (`completed` / `total`), credits, and page bodies (markdown/summary snippets).

## `cancel`

| Input | Default | Meaning |
|---|---|---|
| `job_id` | required | Crawl job id to DELETE. |

Explicit cancel path (same DELETE as the automatic orphan cleanup). Returns a short confirmation with job id and status.

## `batch` / `batch_status` / `batch_cancel`

Scrape many known URLs in one job. Same wait/poll/cancel pattern as crawl. Hard max **100** URLs.

| Input | Default | Meaning |
|---|---|---|
| `urls` | required | Pages to scrape (max 100). |
| `formats`, `only_main_content`, `max_age_ms`, `wait_for`, `mobile` | same as scrape | Applied to every URL. |
| `max_concurrency` | omitted | Max concurrent scrapes. |
| `ignore_invalid_urls` | omitted | Skip invalid URLs instead of failing. |
| `wait` / `poll_timeout_ms` | `true` / 300000 | Same as crawl. |

Job creation (`POST /v2/batch/scrape`) is never retried. Waiting jobs DELETE-cancel on timeout/abort.

## `extract` / `extract_status` / `extract_cancel`

LLM extraction from **known** URLs (wildcards like `https://docs.firecrawl.dev/*` allowed). Requires `prompt` and/or `schema`. Prefer `agent` when you do not already have URLs.

| Input | Default | Meaning |
|---|---|---|
| `urls` | required | URL list or globs (max 100). |
| `prompt` / `schema` | one required | Natural-language extract task and/or JSON schema. |
| `enable_web_search` | omitted | Allow following links outside the URL set. |
| `include_subdomains` | omitted | Include subdomains. |
| `show_sources` | omitted | Include sources in the response. |
| `ignore_invalid_urls` | omitted | Skip invalid URLs. |
| `wait` / `poll_timeout_ms` | `true` / 300000 | Same as crawl. |

Waiting extract jobs attempt DELETE-cancel on timeout/abort.

## `agent` / `agent_status` / `agent_cancel`

Autonomous gather when URLs are **unknown**. Prompt is required. URLs, if supplied, only focus the agent.

| Input | Default | Meaning |
|---|---|---|
| `prompt` | required | What to gather. |
| `schema` | omitted | Structured output schema. |
| `urls` | omitted | Optional focus URLs. |
| `max_credits` | **100** | Credit ceiling; hard max **2500**. |
| `effort` | omitted | `low` / `medium` / `high` (spark-2). |
| `strict_constrain_to_urls` | omitted | Only visit provided URLs. |
| `wait` / `poll_timeout_ms` | `true` / 300000 | Same as crawl. |

Agent bills dynamically. Waiting jobs DELETE-cancel on timeout/abort. Cancelled jobs report status `failed`.

## `interact` / `interact_stop`

Drive a prior scrape session. Requires `scrape_id` from a scrape result, and **exactly one** of `prompt` or `code`.

| Input | Default | Meaning |
|---|---|---|
| `scrape_id` | required | From a prior scrape. |
| `prompt` | one of prompt/code | Natural-language interact task. |
| `code` | one of prompt/code | Playwright / agent-browser code. |
| `language` | `node` | `node` / `python` / `bash` when using `code`. |
| `interact_timeout` | 30 | Execution timeout in **seconds** (1–300). |

Public pages only. Behind-login still needs `xd://browser`.

## Resilience

Same family of retry/backoff as `firecrawl_search`: bounded exponential jitter (base 500 ms, cap 8 s, 3 attempts), `Retry-After` honored against the remaining deadline, aborts normalized to `AbortError`, and the active timeout interrupts a retry sleep.

Status-specific details:

- **Billed POSTs** (`map`, `scrape`, `interact`, and other non-GET bodies): retry **408 / 425 / 429 / 502 / 503 / 504** only — **`500` excluded** because the server may already have billed.
- **GET / DELETE** (status polls, `next` pages, explicit cancel through the shared helper): the retryable set also includes **500**.
- **Job creation** (`POST /v2/crawl`, `/v2/batch/scrape`, `/v2/extract`, `/v2/agent`, and `POST …/interact`) sets `retry: false` and is **never retried**, even on transport errors, so a lost response cannot start a second billed run.
- Poll-loop sleeps are abort-aware; caller abort during wait triggers the DELETE cancel path for crawl, batch, extract, and agent.

## Cost and latency

- **`scrape`, `batch`, and `crawl` bill per page.** Treat every crawled/scraped URL as a chargeable unit.
- **Rule of thumb:** `crawl` cost scales with the page `limit` (default 20, hard max 500). Batch scales with `urls.length` (max 100). Approval text surfaces `Cost: Firecrawl bills per scraped page — up to N pages this call.`
- **`map` is the cheap way to see a site's shape first** — discover URLs and decide what to scrape/crawl before spending per-page credits.
- **Extractor pick:** scrape JSON mode (one known URL) is cheapest; extract is for known URL globs; agent bills dynamically (default ceiling 100 credits, hard max 2500).
- **Interact** bills the live session; keep `interact_timeout` tight.
- Keyless mode remains limited; a stored credential or `FIRECRAWL_API_KEY` raises limits but does not make per-page work free.
- Waiting jobs can run up to `poll_timeout_ms` (default 5 minutes) plus page-accumulation time; use `wait: false` when you want to start the job and poll later.

## Invocation

`read` the device for its live schema, then `write` JSON to **`xd://firecrawl_crawl`**.

### Map a docs site (cheap reconnaissance)

```text
read  xd://firecrawl_crawl

write xd://firecrawl_crawl
{"operation":"map","url":"https://docs.firecrawl.dev","limit":5}
```

### Scrape one public page

```text
write xd://firecrawl_crawl
{"operation":"scrape","url":"https://example.com","formats":["markdown"]}
```

### Crawl with a tight page budget (wait for completion)

```text
write xd://firecrawl_crawl
{"operation":"crawl","url":"https://docs.firecrawl.dev","limit":10,"wait":true,"poll_timeout_ms":120000,"scrape_options":{"formats":["markdown"],"only_main_content":true}}
```

### Start a crawl without waiting, then status / cancel

```text
write xd://firecrawl_crawl
{"operation":"crawl","url":"https://docs.firecrawl.dev","limit":20,"wait":false}

write xd://firecrawl_crawl
{"operation":"status","job_id":"<id from start>","limit":20}

write xd://firecrawl_crawl
{"operation":"cancel","job_id":"<id from start>"}
```

### Scrape JSON mode (one known URL)


```text
write xd://firecrawl_crawl
{"operation":"scrape","url":"https://docs.firecrawl.dev","formats":["json"],"json_prompt":"Extract the page title and description"}
```

### Batch scrape known URLs

```text
write xd://firecrawl_crawl
{"operation":"batch","urls":["https://example.com","https://docs.firecrawl.dev"],"formats":["markdown"],"wait":true}
```

### Agent when URLs are unknown

```text
write xd://firecrawl_crawl
{"operation":"agent","prompt":"Find Firecrawl's founders and current pricing","max_credits":50,"effort":"low","wait":true}
```

### Interact with a prior scrape

```text
write xd://firecrawl_crawl
{"operation":"interact","scrape_id":"<id from scrape>","prompt":"Click Pricing and extract the plan names"}
```
