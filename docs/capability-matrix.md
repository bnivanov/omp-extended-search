# Search fleet capability matrix

Generated 2026-07-25 from a full read of all ten tool sources in `tools/*.ts` (4,279 lines). Source is authoritative; `docs/*.md` was consulted only for stated intent.

> **Snapshot, not a live document.** This records the fleet as it stood on 2026-07-25, *before* the
> resilience pass. Several gaps it lists as open have since been closed — retry/backoff, pagination
> for arXiv/GitHub/HN/Reddit/Product Hunt, the arXiv rate limiter, Product Hunt session credentials,
> the bounded `gh auth token` exec, the missing crawl primitive (`tools/firecrawl_crawl.ts`), and the
> installer lifecycle (`install.sh update`). For what is actually open today, read
> **Known limitations** in [../README.md](../README.md); it is the maintained list.
> Refresh this file by re-running the audit, not by hand-editing it.

**Method** — 10 parallel extraction agents (one per tool) → 5 gap-analysis lenses (coverage, depth, mechanics, ops, workflow) → 32 raw claims deduplicated to 30 → one independent skeptic per claim, prompted to *refute*. 11 confirmed, 19 downgraded to overstated. Line references below were cited by the verifying agent.

**Reading rule** — *built-in* means a tool does it. *Composable* means an agent can hand-write the glue each time. Composable is not coverage; the workflow gaps below are real even though a sufficiently patient agent can work around them.

## Adjacent capabilities (outside these ten tools)

| Surface | Scope |
|---|---|
| built-in `web_search` | native omp provider chain; Firecrawl used natively only when set in `providers.webSearchOrder` |
| `read <url>` | reader-mode fetch of any single URL, `:raw` for untouched HTML; reaches JSON APIs directly (npm, PyPI, arXiv) |
| `xd://browser` | CDP-attached real Chromium, puppeteer `page` + tab helpers, arbitrary JS. **The only surface that sees behind a login.** |
| `xd://github` | authenticated `gh` CLI wrapper: code/commit/issue/PR/repo search, `file_read` |

## Access status

| Tool | Status |
|---|---|
| `firecrawl_search` | ✅ authenticated — smoke-tested live (job `019f9b20…`, 2 credits used) |
| `exa_search` | ✅ `EXA_API_KEY` set |
| `parallel_search` | ✅ `PARALLEL_API_KEY` set |
| `x_search` | ⛔ `XAI_API_KEY` / `XAI_OAUTH_TOKEN` unset — session provider may still resolve |
| `hackernews_search` | ✅ keyless |
| `reddit_search` | ✅ keyless |
| `arxiv_search` | ✅ keyless |
| `feed_search` | ✅ keyless |
| `github_search` | ⚠️ `GITHUB_TOKEN` / `GH_TOKEN` unset; falls back to `gh auth token` |
| `producthunt_search` | ⛔ **dead** — `PRODUCTHUNT_API_TOKEN` is the only path and is unset |

## Confirmed gaps

| Gap | Impact | Fix cost |
|---|---|---|
| [No crawl primitive](#no-crawl-primitive) | high | large |
| [No pagination or continuation](#no-pagination-or-continuation) | high | large |
| [No retry or backoff policy](#no-retry-or-backoff-policy) | high | medium |
| [Parallel tasks orphan on timeout](#parallel-tasks-orphan-on-timeout) | high | small |
| [No per-call spend guard](#no-per-call-spend-guard) | high | medium |
| [No unified run-level budget or reliability model](#no-unified-run-level-budget-or-reliability-model) | high | large |
| [No maps, places, or geospatial backend](#no-maps-places-or-geospatial-backend) | medium | medium |
| [Product Hunt has no working credential path](#product-hunt-has-no-working-credential-path) | medium | small |
| [arXiv can violate its own rate guidance](#arxiv-can-violate-its-own-rate-guidance) | medium | small |
| [No fleet-level fan-out and merge](#no-fleet-level-fan-out-and-merge) | medium | large |
| [No follow-the-citation research loop](#no-follow-the-citation-research-loop) | medium | large |

### No crawl primitive

*high impact · large fix*

`firecrawl_search.ts:377-385` builds only `/v2/search`; Exa `/contents` and Parallel `/v1/extract` both require caller-supplied URLs (≤20); `x_search`'s Firecrawl `/v1/scrape` at `:230-250` is filtered to cited `x.com/status/` URLs. No frontier, sitemap, robots policy, dedupe, or depth budget in any tool.

**Fix** — Add a crawl operation/tool with seed URLs, sitemap/`/map` discovery, a deduplicated URL frontier, depth/page limits, robots policy, and per-page extraction.

### No pagination or continuation

*high impact · large fix*

`arxiv:112-117` hardcodes `start=0`; `github:98-106` sends `per_page` with no `page`; `hackernews:90-103` sends `hitsPerPage` with no `page`; `reddit:172-181` pins `limit=25`; ProductHunt `POSTS_QUERY:20-40` omits `pageInfo`/`endCursor`; Firecrawl/Exa/Parallel/X send one request with no cursor. Upstreams mostly support paging — this is missing wiring, not an API wall.

**Fix** — Expose provider-specific page/offset/cursor inputs and return continuation metadata; add a bounded paginate operation that fetches and deduplicates successive pages.

### No retry or backoff policy

*high impact · medium fix*

Only `reddit_search.ts:125-136` retries — once, fixed 2.5 s, gated on a message regex `/slow down|too many|rate|timeout/i`, so network exceptions slip through. The other nine tools issue one request and throw. No `Retry-After` handling anywhere. Parallel's poll delay is not request retry.

**Fix** — Shared idempotency-aware retry wrapper for network/408/429/5xx, honoring `Retry-After` with bounded exponential jitter; exclude non-replayable task creation unless an idempotency key exists.

### Parallel tasks orphan on timeout

*high impact · small fix*

`parallel_search.ts:368-397` — poll budget expires, the tool throws, and no cancellation request is ever sent; `VALID_OPS` has no cancel. An `ultra8x` run keeps consuming provider work after we walk away.

**Fix** — On timeout or caller abort, call the Parallel cancellation endpoint when a `run_id` exists, with a short bounded timeout; return `run_id` and cancellation status if it fails.

### No per-call spend guard

*high impact · medium fix*

Exa `deep` (180 s), Firecrawl per-result content extraction (credits × results × sources), and Parallel task processors up to `ultra8x` are all selectable with no preflight ceiling, cost estimator, or deny/downgrade policy. Cost surfaces only after the fact (`costDollars`, `creditsUsed`); approval prompts show parameters, not money.

**Fix** — Fleet policy for max estimated credits/cost and max fan-out; preflight reject or explicitly downgrade deep/high-processor/content-scrape requests; standardize usage/cost fields in every response.

### No unified run-level budget or reliability model

*high impact · large fix*

No cross-tool run orchestrator: a multi-tool investigation gets no aggregate deadline, request/cost budget, cancellation fan-out, retry policy, or normalized partial-failure result. Only per-call `AbortSignal` plus provider-local fixed controls (timeouts 12–180 s, concurrency 4–6, ad-hoc partial semantics).

**Fix** — Run controller with deadline/cost/request budgets, cancellation propagation, configurable retry/backoff, bounded concurrency, and a uniform per-node status model that preserves partials.

### No maps, places, or geospatial backend

*medium impact · medium fix*

`exa_search.ts:255,335` `userLocation`; `firecrawl_search.ts:66-67,304-307` `location`/`country`; `parallel_search.ts:211-213,458` `location` — all free-form ranking bias. No coordinates, radius, place details, hours, reviews, or routing anywhere.

**Fix** — Add a maps/places tool backed by a places/geocoding provider: text query, coordinates/radius, place details, optional routing/geocoding.

### Product Hunt has no working credential path

*medium impact · small fix*

`producthunt_search.ts:175-182` errors before the GraphQL call. Only `process.env.PRODUCTHUNT_API_TOKEN` is consulted — no session `authStorage` lookup, no keyless mode, unlike firecrawl/exa/parallel/xai.

**Fix** — Add session `authStorage` resolution for a `producthunt` provider before the env lookup, with an explicit missing-credential error naming the provider and variable.

### arXiv can violate its own rate guidance

*medium impact · small fix*

One immediate keyless fetch per invocation, 20 s timeout, no process-wide limiter, serialization, or retry — against arXiv's documented ~1 request / 3 s guidance which 429s the whole IP. Parallel fan-out over arXiv is a footgun.

**Fix** — Process/session-wide arXiv limiter enforcing the documented spacing, plus bounded `Retry-After`-aware retry for 429/5xx.

### No fleet-level fan-out and merge

*medium impact · large fix*

No generic cross-tool fan-out API: the caller issues separate invocations and implements normalization, dedupe, and ranking. In-tool fan-out exists only within a source family (RSS feed URLs, Reddit subreddits); Parallel multi-query stays inside its own backend.

**Fix** — An `xd://search_workflow` tool accepting ordered tool requests, fan-out/concurrency settings, and merge/ranking policy; executes children, retains partial failures, returns one normalized collection.

### No follow-the-citation research loop

*medium impact · large fix*

No caller-facing automatic citation-following loop with bounded hops and preserved provenance. Search/answer results expose URLs, but Exa `contents` and Parallel `extract` require explicit caller URLs; Firecrawl scraping is per-result inside one search. Parallel `task` runs research provider-side without fleet-wide hop bounds or evidence chains.

**Fix** — Workflow graph with search nodes, URL-expansion/extract nodes, hop and result budgets, URL selection rules, cycle detection, and parent-citation provenance — exposed as one tool call.

## Overstated claims, corrected

Raised by the gap lenses, then narrowed or knocked down by an independent skeptic. Recorded because the correction changes what the fix is.

**Parallel extraction truncates at 8k** · residual impact high  
Real but local: `parallel_search.ts:293-313` slices each formatted body to 8,000 chars and extract details drop `data.results`, even with `full_content=true`. This is our formatter, not upstream — Firecrawl's `details.rawResponse` and `read <url>` retrieve longer content.  
*Fix* — Add a raw/full-content output mode preserving extract bodies with configurable per-document and total byte caps.

**No video or audio corpus** · residual impact medium  
`x_search.ts:94-96,292-293` does set `enable_video_understanding` on the upstream xAI call, and `feed_search` parses podcast RSS (though it ignores `<enclosure>`). Real gap: no YouTube/podcast corpus search, no media download, no transcription.  
*Fix* — Media search/transcription tool: YouTube/podcast search, URL retrieval, audio/video extraction, transcript generation.

**No forum coverage beyond Reddit/HN/X** · residual impact medium  
`feed_search.ts:1-20,170-238` accepts arbitrary RSS/Atom URLs, so public Discourse, Stack Exchange, and mailing-list feeds are reachable best-effort. Real gap: no Stack Exchange or Discourse API adapter, no thread/comment corpus search, no private communities.  
*Fix* — Source-specific adapters — Stack Exchange API and Discourse API/RSS first; authenticated Slack/Discord/LinkedIn are separate connectors.

**No authenticated or paywalled corpus search** · residual impact medium  
`github_search.ts:43-60` resolves `GITHUB_TOKEN`/`GH_TOKEN`/`gh auth token`, `xd://github` is an authenticated wrapper, and `xd://browser` sees behind any login interactively. Real gap: no caller-supplied *site* credential/session passthrough for bulk multi-page corpus extraction.  
*Fix* — Authenticated browser search/extract operation reusing an existing tab/session, with explicit domain allowlist and bounded multi-page collection.

**arXiv retrieves no papers** · residual impact medium  
True of `arxiv_search` alone (`MAX_SNIPPET=500`, abs/PDF links never followed, `start=0`). The fleet can hydrate those URLs via `read <url>`, browser, Exa `contents`, or Parallel `extract`, subject to each extractor's limits.  
*Fix* — Opt-in paper hydration: fetch abs/PDF, extract text with PDF parsing and OCR fallback, configurable page/byte limits.

**Feeds, HN, and Reddit are snippet-only** · residual impact medium  
These three do not self-hydrate linked articles or full threads (feed summary 400 chars, HN 500, Reddit selftext 400; HN never follows Firebase `kids`; Reddit's Arctic Shift endpoint is posts-only). Known URLs can be batch-hydrated via Exa `contents`, Parallel `extract`, `read`, or browser — assembling a *complete thread* still needs a traversal workflow.  
*Fix* — Opt-in hydration: linked-article text for feeds, recursive HN `kids` with depth/comment caps, a Reddit comments endpoint.

**X thread fidelity is not guaranteed** · residual impact medium  
`x_search` has no thread/reply traversal, no cursor, and no full-text guarantee: capture is optional, best-effort, restricted to cited numeric status URLs, and Firecrawl output is capped at 1200 chars (`x_search.ts:20-35,213-278`). Individual known URLs remain fetchable via Exa `contents`, `read`, or browser.  
*Fix* — Opt-in status/thread hydration with reply pagination, raw capture fields, and completeness/error indicators.

**Result caps carry no completeness metadata** · residual impact medium  
arXiv, GitHub, and HN search *do* report upstream total vs. shown (`opensearch:totalResults`, `total_count`, `nbHits`), and Firecrawl preserves `rawResponse`. Real gap: no standardized `has_more`/continuation across HN feed, Exa, Parallel, feeds, Reddit, Product Hunt, and X.  
*Fix* — Normalized `requested`/`returned`/`upstream_total`/`has_more`/`continuation`; warn when a hard cap is hit.

**No cross-tool dedupe or citation model** · residual impact medium  
No canonical URL identity or shared provenance schema; dedupe is provider-local (raw feed URL, Reddit post ID, exact X citation string). Callers *can* merge externally, but get no help with tracking parameters, redirects, or syndicated duplicates.  
*Fix* — Shared citation schema (`canonical_url`, `display_url`, `title`, `snippet`, `provider`, `retrieved_at`, `source_result_id`) plus a merge operation that canonicalizes URLs.

**No result caching** · residual impact medium  
No local or persisted cache; every invocation issues a fresh upstream request. Partial exception: Firecrawl's `max_age_ms` is forwarded as `maxAge` for extracted content, permitting upstream cache reuse — the search POST itself still repeats.  
*Fix* — Shared bounded TTL cache keyed by provider + operation + normalized body + auth scope, with hit/miss metadata and explicit bypass.

**No persistent result store** · residual impact medium  
All ten handlers fetch and return in memory with no fs/db writes; Parallel offers only upstream run correlation. Browser JS can persist to origin-scoped storage, which is ad-hoc and session-bound. Durable searchable history requires caller-managed files.  
*Fix* — SQLite-backed `search_runs`/`results`/`citations`/`artifacts` with run IDs, retrieval filters, and retention.

**No monitoring or snapshot diffing** · residual impact medium  
No persisted snapshot store, diff engine, scheduler, or webhook in any tool; `recency`/`since_days` are one-shot filters. Browser JS can poll and diff client-side, but is page-lifetime-bound with no guaranteed notification.  
*Fix* — A `search_watch` service: source definitions, schedule, persisted canonical snapshots, content hashing and field-aware diffing, webhook delivery.

**No fleet-wide structured extraction** · residual impact medium  
Parallel `task.output_schema` is the sole native JSON-schema path. Nothing consumes merged prior tool results plus a schema and validates the output; browser `evaluate` can approximate it with agent-authored glue.  
*Fix* — Workflow extraction node taking normalized citations plus a JSON Schema, dispatching extraction, validating, and returning field-level evidence pointers.

**No caller-controlled sort order** · residual impact medium  
The wrappers expose only provider ranking or fixed descending order (`arxiv:114-117` hardcodes `sortOrder=descending`; feeds and Reddit sort locally descending). Upstreams generally support ascending — missing wiring, not an API wall. `read <url>` against a raw API URL is the manual bypass.  
*Fix* — Expose validated `sort_order` where upstream supports it (arXiv/GitHub/Reddit/feeds); add a documented local ordering stage elsewhere. Requires pagination to be meaningful.

**Relative-only date windows** · residual impact medium  
arXiv, HN, Reddit, feeds, and Product Hunt accept only relative/lower-bound filters (`created_at_i>=`, `after`, `postedAfter`, `sinceMs`) with no caller-facing absolute `start`/`end`. Exa and X do accept absolute ranges. Direct-URL or browser workflows can express intervals, but that is not a typed parameter.  
*Fix* — Add ISO-validated `start_date`/`end_date` to arXiv/HN/Reddit/feed/Product Hunt; map both bounds upstream where possible, post-filter with an explicit completeness caveat otherwise.

**Feed query has no phrase or boolean support** · residual impact medium  
`feed_search`'s `query` is case-insensitive whitespace-token AND substring matching against title and the 400-char-truncated summary. Phrases/OR require a provider URL (e.g. Google News `q=`), another tool (Exa `include_text`, arXiv quoted `all:`), or local post-filtering.  
*Fix* — Structured expression (`all`/`any`/`phrase`/`none`) evaluated against normalized full feed text before truncation.

**GitHub credential helper is unbounded** · residual impact medium  
`github_search.ts:45-56` awaits `host.exec('gh', ['auth','token'], {})` with no options; the 15 s HTTP timeout (`FETCH_TIMEOUT_MS`) starts only after resolution returns. Indefinite hang is not proven from this repo, but the helper is outside the tool's deadline.  
*Fix* — Give `host.exec` a deadline compatible with the tool signal, or race credential lookup against a bounded timeout and proceed unauthenticated with a diagnostic.

**No non-GitHub code host search** · residual impact low  
`exa_search.ts:441-468` (`/contents`) and `parallel_search.ts:550-583` (`/v1/extract`) fetch arbitrary caller URLs, and Firecrawl `include_domains` + `content=markdown` extracts indexed public pages. Real gap: no host-native normalized repo/code search for GitLab, Bitbucket, Gitea, or SourceHut.  
*Fix* — Code-host adapter with host selection — GitLab REST project/code search and Bitbucket API first, with pagination and file content.

**No package registry metadata** · residual impact low  
`read https://registry.npmjs.org/<pkg>` and `read https://pypi.org/pypi/<pkg>/json` return authoritative version, license, and dependency JSON today. Real gap: no cross-registry package-name discovery or normalized dependency-graph tool.  
*Fix* — `registry_search` with a registry enum and normalized package/version/dependency/license output — npm, PyPI, crates.io first.

## Per-tool surface

### `firecrawl_search`

**Backend** — POST `${(asString(process.env.FIRECRAWL_BASE_URL) || "https://api.firecrawl.dev").replace(/\/+$/, "")}/v2/search`; with no FIRECRAWL_BASE_URL, the literal endpoint is `https://api.firecrawl.dev/v2/search`.

**Auth** — Credential resolution is exact and ordered: call `ctx?.modelRegistry?.authStorage.getApiKey("firecrawl", ctx?.sessionManager?.getSessionId?.())`; if it returns a key, use session auth. If unavailable/empty/error, use trimmed `process.env.FIRECRAWL_API_KEY`; otherwise use keyless mode. A selected key is sent as `Authorization: Bearer <key>`; output records only `Bearer [REDACTED] (session|env)`. Keyless requests have no Authorization header.

**Operations**

- search (the only operation; there is no operation input selector)

**Parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Required; trimmed; 1–500 characters inclusive. |
| `limit` | number | 10 | Optional integer, 1–100 inclusive; sent as results per source, not a total cap. |
| `sources` | array of enum strings | ["web"] | Optional, at least 1 item; each item is exactly one of `web`, `news`, `images`. |
| `categories` | array of enum strings | — | Optional, at least 1 item; each item is exactly one of `github`, `research`, `pdf`. |
| `include_domains` | array of strings | — | Optional; every item is trimmed and must be nonempty. Mutually exclusive with `exclude_domains`. |
| `exclude_domains` | array of strings | — | Optional; every item is trimmed and must be nonempty. Mutually exclusive with `include_domains`. |
| `tbs` | string | — | Optional; trimmed and nonempty. Raw time-filter syntax is accepted without further schema validation. Mutually exclusive with `recency`. |
| `recency` | enum string | — | Optional; exactly one of `hour`, `day`, `week`, `month`, `year`; maps respectively to `qdr:h`, `qdr:d`, `qdr:w`, `qdr:m`, `qdr:y`. Mutually exclusive with `tbs`. |
| `location` | string | — | Optional; trimmed and nonempty. |
| `country` | string | — | Optional; trimmed; exactly 2 characters (min/max 2). The tool omits the field unless supplied, despite the upstream default documented as US. |
| `highlights` | boolean | true | Optional; controls the request's `highlights` field. |
| `content` | enum string | none | Optional; exactly one of `none`, `markdown`, `summary`, `links`. Values other than `none` request per-result extraction via `scrapeOptions.formats`; `none` omits scrapeOptions. |
| `only_main_content` | boolean | — | Optional; only included as `scrapeOptions.onlyMainContent` when `content` is not `none`; otherwise ignored. |
| `max_age_ms` | number | — | Optional integer >= 0; only included as `scrapeOptions.maxAge` when `content` is not `none`; otherwise ignored. |
| `timeout_ms` | number | 60000 | Optional positive integer (>=1); sent as top-level API `timeout` and used for the client request timeout. |
| `scrape_timeout_ms` | number | — | Optional integer, 1,000–300,000 inclusive; only included as `scrapeOptions.timeout` when `content` is not `none`; otherwise ignored. |
| `ignore_invalid_urls` | boolean | — | Optional; when provided, sent as top-level `ignoreInvalidURLs`. |

**Output** — Returns visible text headed `# Firecrawl advanced search`, grouped into requested/nonempty Web, News, and Images sections. Web/news items render title, URL, optional news date/imageUrl, a compacted description/snippet (whitespace collapsed and visible text capped at 1,600 chars), item errors, and requested markdown/summary/links content. Image items render title, source URL, image URL, dimensions, and item errors. Top-level warning, id, and creditsUsed are rendered when present. The returned details include `request` (provider, operation, POST method, URL, redacted authentication, camelCase body) and complete `rawResponse`; partial per-item errors are retained. Content rendering truncates displayed extracted text to 5,000 chars and displays at most 30 links, while rawResponse remains available.

**Hard limits**

- `query` is capped at 500 characters.
- `limit` is capped at 100 per selected source; selecting multiple sources can return up to that many from each source.
- `scrape_timeout_ms` is capped at 300,000 ms and has a 1,000 ms minimum.
- There is no pagination support in the tool or documented endpoint: no cursor, page, offset, or next-token input/output is wired.
- The client abort timeout is `timeout_ms` plus a grace period computed as 10% of it, bounded to 1,000–5,000 ms.
- Visible snippets are compacted/capped at 1,600 characters; visible extracted content is capped at 5,000 characters; visible links are capped at 30 per item. Complete raw response is retained in details.

**Verified absent**

- Cannot select an operation other than `search`; no operation/mode selector or separate extract/search-answer mode exists.
- Cannot request a `text` extraction format through the schema; extraction choices are only `markdown`, `summary`, and `links` (or `none`).
- Cannot request full-page extraction by default: `content` defaults to `none`, and scrape-only controls are ignored unless content is non-`none`.
- Cannot paginate or continue a result set: no cursor, page, offset, or next-token parameter is exposed or processed.
- Cannot sort results: no sort/order parameter is accepted or sent.
- Cannot use GET or another HTTP method; the source always POSTs JSON to `/v2/search`.
- Cannot use both domain inclusion and exclusion filters in one call; schema validation rejects `include_domains` together with `exclude_domains`.
- Cannot use both raw `tbs` and convenience `recency` in one call; schema validation rejects that combination.
- Cannot expose the Firecrawl credential in output; request details deliberately redact it (this is an output restriction, not an upstream API limitation).

### `exa_search`

**Backend** — POST https://api.exa.ai/search; POST https://api.exa.ai/answer; POST https://api.exa.ai/contents (all requests JSON body with Content-Type: application/json and x-api-key header)

**Auth** — Credential resolution order: first ctx.modelRegistry.authStorage.getApiKey("exa", sessionId), where sessionId is ctx.sessionManager.getSessionId?.(); if a truthy key is returned, authMode=session. Exceptions or missing storage fall through. Then process.env.EXA_API_KEY gives authMode=env. If neither exists, execution returns an error; keyless operation is not supported.

**Operations**

- search (selected when operation is omitted; runtime fallback for invalid values)
- answer (selected by operation="answer")
- contents (selected by operation="contents")

**Parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Required; Zod min length 1. Used as search query, answer question, contents summary focus; because schema is shared it is required even for contents. |
| `operation` | enum string | search | Allowed values: search, answer, contents. |
| `type` | enum string | auto (unless OMP_EXA_DEFAULT_TYPE supplies a valid value) | Allowed values: auto, fast, neural, deep, keyword, instant. Search-oriented; runtime maps keyword and instant to fast. Invalid environment default falls back to auto. |
| `num_results` | integer number | 10 (from OMP_EXA_DEFAULT_NUM_RESULTS, clamped) | Optional, min 1 max 100. Search result count. If both num_results and limit are supplied, num_results wins via nullish-coalescing precedence; no schema mutual exclusion. |
| `limit` | integer number | — | Optional alias for num_results, min 1 max 100. Ignored when num_results is supplied; no schema mutual exclusion. |
| `contents` | enum string | summary (unless OMP_EXA_DEFAULT_CONTENTS supplies a valid value) | Allowed values: summary, text, highlights, none, all. Search content packing. none omits the contents request; otherwise fine-tuning fields can add requested sections. |
| `category` | enum string | — | Allowed values: company, research paper, news, pdf, github, personal site, people, financial report, tweet. Search only; runtime lowercases before accepting. |
| `include_domains` | array of strings | — | Optional. Search only; runtime trims nonempty strings and keeps at most 50. |
| `exclude_domains` | array of strings | — | Optional. Search only; runtime trims nonempty strings and keeps at most 50. |
| `start_published_date` | string | — | Optional search lower bound, described as ISO date/time; schema does not validate format and runtime only requires a nonblank string. |
| `end_published_date` | string | — | Optional search upper bound, described as ISO date/time; schema does not validate format and runtime only requires a nonblank string. |
| `start_crawl_date` | string | — | Optional search crawl-date lower bound; no format validation. |
| `end_crawl_date` | string | — | Optional search crawl-date upper bound; no format validation. |
| `include_text` | array of strings | — | Optional search phrase requirements; runtime trims/filter strings and keeps at most 5. |
| `exclude_text` | array of strings | — | Optional search phrase exclusions; runtime trims/filter strings and keeps at most 5. |
| `additional_queries` | array of strings | — | Optional extra search variants; runtime trims/filter strings and keeps at most 5. |
| `summary_query` | string | — | Optional search summary-focus override. A nonempty value causes summary contents to be requested even if contents mode alone would not request it. |
| `highlights_query` | string | — | Optional search highlights-focus query. A value causes highlights contents to be requested. |
| `highlights_per_url` | integer number | 3 when supplied but invalid/nonfinite at runtime | Optional, min 1 max 10. Passed as highlightsPerUrl when highlights are requested. |
| `highlights_num_sentences` | integer number | 3 when supplied but invalid/nonfinite at runtime | Optional, min 1 max 20. Passed as numSentences when highlights are requested. |
| `text_max_characters` | integer number | 2000 when supplied but invalid/nonfinite at runtime | Optional, min 100 max 50000. Passed as text.maxCharacters when text is requested; providing it also causes text contents to be requested. |
| `user_location` | string | — | Optional search location bias, described as ISO country code (for example US); runtime only requires nonblank string. |
| `moderation` | boolean | — | Optional search flag; request field is sent only when exactly true (false is omitted). |
| `livecrawl` | string | — | Optional search livecrawl preference; arbitrary string accepted by schema/runtime (description examples: fallback/preferred), nonblank values sent. |
| `max_age_hours` | integer number | — | Optional search freshness value, min 0 with no schema maximum; runtime clamps to integer range 0..43800 (5*365*24), using 24 as runtime fallback for nonfinite values. |
| `urls` | array of strings | — | Optional; intended for contents. Runtime trims/filter strings and keeps at most 20; contents execution errors if no nonempty URL remains. |
| `text` | boolean | — | Optional; intended for answer. Answer request sends text: true only when exactly true; contents operation ignores this input and always requests text. |

**Output** — search returns one formatted text block headed "# Exa search (...)" with request metadata (when present), each result's title/URL/author/published date and a selected summary/highlights/text snippet normalized and capped at 1200 characters. Details.response contains provider, operation, normalized type, numResults, category, authMode, requestId, resolvedSearchType, costDollars, searchTime, numSearches, sources (title,url,snippet capped 500,publishedDate,author), and rawResultCount. answer returns formatted answer text plus citations (citation snippets capped 300); details.response contains provider, operation, authMode, requestId, costDollars, answer, citations. contents uses the search formatter over returned results and details.response contains provider, operation, authMode, requestId, costDollars, results. Errors are returned as isError text except abort/timeout errors, which are rethrown.

**Hard limits**

- Schema limits num_results and limit to integers 1..100; runtime also clamps/defaults them to 1..100.
- Runtime caps include_domains/exclude_domains at 50 entries, include_text/exclude_text/additional_queries at 5, and urls at 20; arrays are filtered to nonblank trimmed strings.
- Runtime clamps highlights_per_url to 1..10, highlights_num_sentences to 1..20, text_max_characters to 100..50000, and max_age_hours to 0..43800.
- Request timeouts: search 120000ms normally, 180000ms for normalized type deep; answer 90000ms; contents 120000ms.
- Search/answer/contents each issue one POST request; source contains no pagination loop or continuation handling.
- Formatted search snippets are capped at 1200 characters; extracted source snippets in details are capped at 500 and answer citation snippets at 300.

**Verified absent**

- No pagination controls or continuation handling (no page, offset, cursor, token, or pagination loop is wired).
- No search sort/ranking-order parameter is exposed.
- No caller-selectable request timeout is exposed; timeout values are fixed by operation/type.
- The shared schema requires query for every operation, so contents cannot be called through this tool without a query even though its URL fetch body only uses query optionally for summary.
- Contents does not expose controls for selecting/configuring returned content: execution always sends text:true and highlights:true, and only optionally sends summary:{query}; the urls input is the only source-selection control.
- Answer does not expose answer-generation controls beyond query and the text boolean; no caller-provided domains, category, search type, result count, or other search filters are wired into the /answer body.
- No arbitrary upstream request-body fields, headers, or HTTP methods are pass-through parameters.
- The tool does not return raw search result objects wholesale in its formatted/source output; search source entries are reduced to title, url, a <=500-character snippet, publishedDate, and author (although contents details does retain data.results).
- No full-page extraction control/output is available for search beyond the selected Exa contents modes and formatter snippets; formatted search output truncates displayed snippets to 1200 characters.
- ? No explicit API-level validation/normalization is added for date strings, user_location, or livecrawl beyond nonblank-string filtering, so malformed values are not rejected by this tool itself.

### `parallel_search`

**Backend** — Constructs and calls https://api.parallel.ai/v1/search (POST search), https://api.parallel.ai/v1/extract (POST extract), and https://api.parallel.ai/v1/tasks/runs (POST create task); task polling uses GET https://api.parallel.ai/v1/tasks/runs/${encodeURIComponent(runId)} and, on completion, GET https://api.parallel.ai/v1/tasks/runs/${encodeURIComponent(runId)}/result. Requests send JSON, x-api-key, and parallel-beta=search-extract-2025-10-10.

**Auth** — Credential resolution is first session then environment: resolve ctx.modelRegistry.authStorage.getApiKey("parallel", ctx.sessionManager.getSessionId()) when available; a returned key is used with authMode=session. If unavailable or lookup throws, process.env.PARALLEL_API_KEY is used with authMode=env. Without either credential the tool returns an error; keyless operation is not supported. The key is sent as x-api-key.

**Operations**

- search (selected by operation="search" or omitted; builds objective/search_queries/mode and advanced settings, then POST /v1/search)
- extract (selected by operation="extract"; requires nonempty urls after trimming/filtering, then POST /v1/extract)
- task (selected by operation="task"; requires task_input, objective, or query, creates a run on /v1/tasks/runs and polls it until completed/failed/cancelled or timeout)

**Parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Optional; schema min length 1. Primary query/objective and fallback input for search/task; search rejects the request if neither query nor search_queries nor objective supplies a usable string. For extract it is an optional focus. Runtime trims nonblank strings. |
| `objective` | string | — | Optional natural-language goal; runtime trims nonblank strings. Search objective defaults to query, and if both are absent can be sourced from the first search_queries entry; task input fallback is objective then query; extract sends it as focus. |
| `operation` | enum: search \| extract \| task | search | Optional. Runtime treats an absent/invalid value as search (schema normally rejects invalid enum values). |
| `mode` | enum: turbo \| basic \| advanced \| fast \| one-shot \| one-shot-new \| agentic \| research \| comprehensive \| parallel \| minimal | advanced (or OMP_PARALLEL_DEFAULT_MODE when it is one of turbo/basic/advanced; otherwise advanced) | Optional search mode. Canonical values are turbo/basic/advanced. Aliases map fast/one-shot/one-shot-new→basic; agentic/research/comprehensive/parallel→advanced; minimal→turbo. Case is normalized at runtime. Invalid values fall back to the configured/default canonical mode. |
| `search_queries` | array<string> | — | Optional; schema imposes no item count or item-length bound. Runtime trims/filter-removes blank items and keeps at most 10. Search uses these directly; if absent/empty it auto-fills one query from query or objective, and errors if none is available. Extract may send up to 10. |
| `max_results` | integer number | 10 | Optional; schema range 1..40 inclusive. Search max-results selector with highest precedence over limit and num_results (max_results ?? limit ?? num_results). Runtime clamps to 1..40. |
| `limit` | integer number | 10 when no max_results or num_results is supplied | Optional; schema range 1..40 inclusive. Alias/fallback for max_results; ignored when max_results is supplied. |
| `num_results` | integer number | 10 when max_results and limit are absent | Optional; schema range 1..40 inclusive. Alias/fallback for max_results; ignored when max_results or limit is supplied. |
| `max_chars_per_result` | integer number | — | Optional search setting; schema range 200..50,000 inclusive. Sent as advanced_settings.excerpt_settings.max_chars_per_result. |
| `max_chars_total` | integer number | — | Optional; schema range 500..500,000 inclusive. Search sends it top-level; extract sends it top-level. Runtime fallback used by clampInt is 50,000 when a value is present but non-finite (normally impossible through schema), and runtime clamps 500..500,000. |
| `include_domains` | array<string> | — | Optional source policy. No schema item/count/domain-format validation. Runtime trims/removes blank items and caps at 20; may be supplied together with exclude_domains. Search places it under advanced_settings.source_policy; task places it under source_policy; extract does not wire it. |
| `exclude_domains` | array<string> | — | Optional source policy. No schema item/count/domain-format validation. Runtime trims/removes blank items and caps at 20; may be supplied together with include_domains. Search places it under advanced_settings.source_policy; task places it under source_policy; extract does not wire it. |
| `location` | string | — | Optional; documented as ISO 3166-1 alpha-2 country code, but schema does not validate that format. Search only: runtime lowercases nonblank value and sends advanced_settings.location. |
| `live_fetch` | boolean | false/effectively off when omitted | Optional search setting. Only literal true enables advanced_settings.fetch_policy={max_age_seconds:0}; false/omitted sends no live-fetch policy. If max_age_seconds is also provided, live_fetch=true takes precedence. |
| `max_age_seconds` | integer number | — | Optional search setting; schema minimum 0 with no declared maximum. Runtime clamps to 0..31,536,000 (365 days) and uses fallback 86,400 for non-finite supplied values. Ignored when live_fetch is true. |
| `session_id` | string | — | Optional nonblank correlation identifier at runtime. Search/extract send it top-level; approval display shows it for search/extract. Task does not send session_id (only previous_interaction_id). |
| `client_model` | string | — | Optional nonblank string at runtime. Search/extract send it top-level; task does not use it. |
| `urls` | array<string> | — | Optional schema-wise; required for operation=extract after runtime trim/filter. Runtime keeps at most 20 nonblank strings. Extract with no usable URLs returns an error. |
| `full_content` | boolean | false | Optional extract flag. Extract sends top-level full_content=true only when literal true; otherwise false. |
| `excerpts` | boolean | true | Optional extract flag. Extract sends top-level excerpts=true unless literal false. Both excerpts and full_content can be supplied; they are not schema-mutually-exclusive. |
| `processor` | enum: lite \| base \| core \| pro \| ultra \| ultra2x \| ultra4x \| ultra8x | base (or OMP_PARALLEL_DEFAULT_PROCESSOR when valid) | Optional task processor. Runtime lowercases and falls back to configured/default base for invalid values. Environment value is accepted only from the listed enum. |
| `output_schema` | string \| record<string, any> | — | Optional task schema. A string is wrapped as {type:'text',description:<string>}; an object with type exactly auto/text/json is passed as the wrapper; any other object is treated as a bare JSON Schema and wrapped as {type:'json',json_schema:<object>}. Schema does not constrain record keys/values or validate JSON-Schema shape. |
| `task_input` | string \| record<string, any> | objective, then query | Optional task payload. If present, it wins over objective/query, including an object payload. Task errors only for null or empty-string resulting input; schema does not require a nonempty string or nonempty object. |
| `previous_interaction_id` | string | — | Optional nonblank runtime string. Task sends it as previous_interaction_id; no format validation. |
| `poll_timeout_ms` | integer number | 180000 (or OMP_PARALLEL_MAX_POLL_MS clamped to 5,000..900,000) | Optional task polling budget; schema range 5,000..900,000 inclusive. Runtime clamps to that same range. Polling uses exponential-ish delays (starting 800ms, max 5s); task create/poll/result HTTP calls have separate fixed timeouts. |

**Output** — Returns host-tool objects with content containing one formatted text document plus details.response metadata. Search text includes mode, optional searchId, usage, warnings, objective, search_queries, and each result's title/url/published date plus a snippet; only results with a usable URL survive, and snippets are capped at 2,000 characters. Search details include provider, operation, mode, authMode, searchId, usage, warnings, objective, search_queries, normalized sources, and rawResultCount. Extract text includes extractId, usage, each result title/url/published date and excerpts or full_content (body formatter caps each body at 8,000 characters), followed by formatted errors. Extract details include provider, operation, authMode, extractId, usage, warnings, resultCount, and errorCount. Task text includes processor/status, run/interaction IDs, error, output (structured JSON or text capped at 20,000 characters), and up to 30 basis sources with excerpts capped at 240 characters. Task details include provider, operation, authMode, processor, runId, status, interactionId, the full run object, and result.output. Failed/cancelled tasks set isError; ordinary API/validation errors return isError text, while abort/timeout-shaped AbortError or TimeoutError exceptions are rethrown.

**Hard limits**

- Search mode HTTP timeout is 120,000ms for advanced and 60,000ms for turbo/basic; extract HTTP timeout is 120,000ms; task creation timeout is 60,000ms, each poll GET 30,000ms, and completed-result GET 60,000ms.
- Task polling budget is 5,000..900,000ms, default 180,000ms, with no continuation after the budget expires; timeout raises an error and no cancellation request is issued.
- Runtime caps search_queries, include_domains, and exclude_domains at 10/20/20 items respectively, and urls at 20 items; schema itself only declares the urls description 'up to 20' and does not declare array max constraints.
- Search result snippets are formatted/truncated to 2,000 characters; extract formatted document body is truncated to 8,000 characters; task output to 20,000 and basis to 30 entries/240-character excerpts.
- max_age_seconds is runtime-limited to 0..31,536,000 seconds despite schema declaring only min 0.
- No pagination controls or multi-page retrieval loop are implemented; each search is one POST and the task poll is a single run lifecycle.
- No retry/backoff for failed HTTP requests is implemented (task status polling has delay growth, but request failures are not retried).

**Verified absent**

- Does not expose a search pagination parameter or follow-up page retrieval; the source performs one POST /v1/search and formats that response.
- Does not expose a search sort/order parameter, category/type filter, or arbitrary upstream search request fields; only the declared objective, queries, mode, result/character, source-domain, location, and fetch-age fields are wired.
- Does not expose a standalone search full-page-content mode; full_content is only an extract-operation flag for known URLs.
- Does not wire include_domains/exclude_domains, session_id, or client_model into extract requests, even though those parameters exist and are used by search/task or are accepted in the schema.
- Does not provide arbitrary extract URL metadata/options beyond urls, objective/query, search_queries, max_chars_total, session_id/client_model, and excerpts/full_content; notably no extract pagination or sort controls are implemented.
- Does not return unbounded/raw page text through the formatted output: extract body is selected as excerpts first (full_content is only fallback in the formatter) and capped at 8,000 characters per result.
- Does not expose a task cancellation operation or endpoint; it only creates, polls, and fetches the result for terminal completion.
- Does not expose a task list/history operation, arbitrary task-run retrieval, or separate continuation control beyond previous_interaction_id on task creation.
- Does not support keyless use and does not accept credentials through a direct tool parameter; credentials come only from the omp session provider lookup or PARALLEL_API_KEY.
- Docs explicitly distinguish it from an Exa semantic/neural/'pages like this' index and from X-native search; the source offers no semantic embedding/similarity or X/Twitter operation.
- Does not provide an API-level option to independently request/format multiple output representations; formatting is fixed by operation and the returned text/details are a normalized subset rather than the complete upstream response.

### `x_search`

**Backend** — Primary request: POST https://api.x.ai/v1/responses (redirect:'error'). Optional capture backends: GET https://cdn.syndication.twimg.com/tweet-result?id=<tweet-id>&token=<computed-token>&lang=en; POST https://api.firecrawl.dev/v1/scrape.

**Auth** — resolveToken checks ctx.modelRegistry.authStorage.getApiKey(provider, sessionId) first, in exact order xai-oauth then xai; first truthy key wins. If neither works/exists, checks process.env.XAI_OAUTH_TOKEN first, then process.env.XAI_API_KEY (the || expression; env authMode is oauth when XAI_OAUTH_TOKEN is present, otherwise api_key). If no credential, execute returns an error instead of making the request. Session xai-oauth is labeled oauth, xai as api_key. Auth is sent as Authorization: Bearer <token>.

**Operations**

- Search public X posts through xAI Responses API native tool type x_search; one Responses request per execute call.
- Optional cited-post capture when capture=true: syndication (default/fallback) or Firecrawl, limited to cited URLs matching x.com or twitter.com /<user>/status/<numeric-id>.
- Answer/source rendering: parse synthesized output text, collect/deduplicate URL annotations and citations, cap sources locally, optionally append captured post metadata/text.

**Parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Required by the arktype input schema; sent verbatim as the user message. |
| `model` | string | grok-4.3 (unless OMP_XSEARCH_MODEL is set before launch) | Arbitrary string; sent as the xAI Responses model. No source-level enum or length/range validation. |
| `reasoning_effort` | "low" \| "medium" \| "high" | high (unless valid OMP_XSEARCH_EFFORT is set before launch) | Only these three enum values are accepted by the schema. Runtime uses params value or computed default. |
| `focus` | "relevance" \| "volume" | relevance | Only these enum values. Runtime treats only exact volume as volume; otherwise relevance. Controls prompt directive, not an xAI tool field. |
| `recency` | "day" \| "week" \| "month" \| "year" | — | Only these enum values. Used only when from_date is absent/null; computes from_date as current time minus 1/7/30/365 days, sliced to YYYY-MM-DD. |
| `limit` | number | 10 | No numeric range in the input schema. Runtime: finite number >0 is floored and capped at 30; all non-numbers, non-finite values, and values <=0 use 10. Thus positive values below 1 floor to 0. Used as local maximum source count and prompt target. |
| `allowed_handles` | string[] | — | Each value is trimmed, leading @ characters removed, case-insensitively deduplicated, and at most first 20 retained. Empty/fully empty input becomes unset. Sent upstream as allowed_x_handles. Mutually exclusive with excluded_handles only when both normalize to nonempty lists. |
| `excluded_handles` | string[] | — | Same normalization/deduplication and 20-handle cap as allowed_handles. Sent upstream as excluded_x_handles. Mutually exclusive with nonempty normalized allowed_handles. |
| `from_date` | string | — | Runtime requires exact /^d{4}-d{2}-d{2}$/ shape (YYYY-MM-DD); calendar validity is not checked. Takes precedence over recency. Sent upstream as from_date. |
| `to_date` | string | — | Same exact YYYY-MM-DD shape check; no calendar validity check. Sent upstream as to_date. If both dates exist, lexical comparison rejects from_date after to_date. |
| `enable_image_understanding` | boolean | — | When truthy, adds enable_image_understanding:true to the upstream x_search tool object; false/absent omitted. |
| `enable_video_understanding` | boolean | — | When truthy, adds enable_video_understanding:true to the upstream x_search tool object; false/absent omitted. |
| `capture` | boolean | off/false | When true and citations exist, resolves each status permalink after the xAI response. Capture is best effort; errors are attached per source. |
| `capture_provider` | "syndication" \| "firecrawl" | syndication | Only these enum values. firecrawl is selected only when requested and FIRECRAWL_API_KEY exists; otherwise capture silently falls back to syndication. Provider is irrelevant when capture is false. |

**Output** — Successful result has content:[{type:"text",text:<rendered answer/sources>}], plus details.response: provider:"xai-x", model, reasoningEffort, focus, authMode, requestId, answer, sources, and optional capture:{provider,captured,total}. The answer comes from response.output_text or output item/content text parts. Sources are URL annotations (title/url/snippet from title, url, cited_text/text) collected at top-level, output-item, and content-part levels, plus response.citations strings; URLs are deduplicated and sliced to the local limit. Snippets are truncated to 240 characters for rendering. Capture adds provider/text/author/date/likes/replies/quoted fields where available; Firecrawl capture text is trimmed to 1200 chars. Empty answer and sources returns a no-results text, distinguishing whether server-side x_search_calls was >0.

**Hard limits**

- Input schema has no pagination/cursor/offset parameter; execute performs one xAI Responses call and does not paginate.
- Input schema has no upstream result-count parameter. limit is a local source slice and prompt target; docs/source state xAI native x_search has no min/max-results knob.
- limit local cap is 30; default is 10 (with the runtime edge case that 0<limit<1 floors to 0).
- Each handle list is normalized and capped at 20 entries.
- Dates are accepted only in exact YYYY-MM-DD textual shape; from_date after to_date is rejected, while impossible calendar dates are not rejected by this code.
- Capture concurrency is capped at 6 workers; syndication requests timeout after 8000 ms and Firecrawl requests after 30000 ms. Firecrawl request itself asks timeout:27000 ms.
- Firecrawl capture truncates markdown to 1200 characters; syndication captures returned fields without an analogous source-code character cap.
- Only cited URLs containing a numeric /status/<id> are capture targets; non-status citations are not fetched.
- Firecrawl capture requires FIRECRAWL_API_KEY; absent key causes requested Firecrawl to use syndication instead. Syndication requires no configured key.
- No source-schema exposure for max_tokens or temperature, despite unreachable conditional reads in execute; validated tool inputs cannot set them.

**Verified absent**

- Cannot perform write actions on X (post, reply, like, repost), send DMs, or access protected/private content; source description and docs scope it to public posts and docs explicitly list these omissions.
- Cannot provide exact views/bookmarks, a streaming firehose, or a full archive; docs explicitly identify these as unavailable and requiring the paid X API.
- Cannot search general web pages through this tool; its description explicitly directs general web-page searches to web_search.
- Cannot request pagination/cursors or a server-side min/max result count: neither is in the input schema, and the code makes one Responses call; limit only truncates collected citations and guides the prompt.
- Cannot expose arbitrary xAI Responses controls through the declared schema. In particular max_tokens and temperature are not declared parameters, so their execute branches are unreachable through normal schema-validated calls.
- Cannot capture arbitrary URLs or non-status citations: captureSources filters for x/twitter.com numeric status URLs.
- Cannot guarantee raw/full post text for every citation: capture is optional, best-effort, status-only, may return deleted/protected/unavailable errors, and Firecrawl text is capped at 1200 chars.
- Cannot guarantee Firecrawl-specific capture when FIRECRAWL_API_KEY is absent; implementation silently falls back to syndication.
- Cannot validate whether YYYY-MM-DD is a real calendar date (only format and ordering are checked).
- Cannot force a distinct-post count or guarantee broad coverage; focus/limit are prompt guidance/local capping, while docs state the native x_search has no min/max-results knob.

### `hackernews_search`

**Backend** — Search mode constructs either https://hn.algolia.com/api/v1/search (sort=relevance/default) or https://hn.algolia.com/api/v1/search_by_date (sort=date). Feed mode constructs https://hacker-news.firebaseio.com/v0/{topstories|newstories|beststories|askstories|showstories|jobstories}.json, then fetches each selected item from https://hacker-news.firebaseio.com/v0/item/{id}.json. Output links are additionally constructed as https://news.ycombinator.com/item?id={id}.

**Auth** — No credentials, API keys, environment variables, or login are read or required; documentation explicitly says free/keyless/no env vars. Requests use a fixed User-Agent header (omp-extended-search).

**Operations**

- search (default), selected by operation="search" or when operation is absent; requires a nonblank query at runtime
- feed, selected by operation="feed"; ignores query and uses the Firebase feed/list path

**Parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | absent | Optional in schema; required at runtime for search (must exist and String(query).trim() must be nonempty). Ignored in feed mode. |
| `operation` | enum string | search | Schema enum exactly ["search","feed"]. The implementation treats only exactly "feed" as feed; all other/absent values take search branch (schema prevents other values). |
| `tags` | array of string | absent | Schema is z.array(z.string()), with no per-element enum/range. At URL-build time only exact values story, comment, ask_hn, show_hn, job, poll are retained; unknown values are silently discarded. If at least one retained value exists it is sent as a comma-joined tags parameter. Description says multiple values are ANDed. |
| `sort` | enum string | relevance | Schema enum exactly ["relevance","date"]. Only exact date selects search_by_date; relevance selects search. No effect in feed mode. |
| `min_points` | integer number | absent | Schema requires integer and min(0), i.e. >=0. When >0, floor is used and numericFilters receives points>=N; 0 is accepted but omitted from the request. No effect in feed mode. |
| `min_comments` | integer number | absent | Schema requires integer and min(0), i.e. >=0. When >0, floor is used and numericFilters receives num_comments>=N; 0 is accepted but omitted from the request. No effect in feed mode. |
| `recency` | enum string | absent | Schema enum exactly ["day","week","month","year"], mapped to 1, 7, 30, 365 days. Used only if since_days is not a positive number; then emits created_at_i >= current Unix time minus that window. No effect in feed mode. |
| `since_days` | number | absent | Schema requires number and min(0), i.e. >=0; not required to be integer. A positive value overrides recency and is floored when constructing the Unix timestamp filter (created_at_i>=...). Zero is accepted but is falsy in the implementation, so recency can still be used. No effect in feed mode. |
| `limit` | integer number | 10 | Schema integer range 1–50 inclusive (MAX_LIMIT=50). Search hitsPerPage is additionally clampInt-floored/clamped to [1,50]. No effect in feed mode. |
| `feed` | enum string | top | Schema enum exactly ["top","new","best","ask","show","job"]. Used only for feed mode; invalid/absent values fall back to top in implementation (schema prevents invalid values). Maps respectively to topstories, newstories, beststories, askstories, showstories, jobstories. |
| `count` | integer number | 10 | Schema integer range 1–30 inclusive (MAX_FEED_COUNT=30). Feed mode clampInt-floors/clamps to [1,30] before slicing the returned ID list. No effect in search mode. |

**Output** — Returns an object with content: one text part. Search text is formatted from Algolia data: total nbHits, up to returned hits, HN item URL, optional external URL, metadata, and story/comment text stripped of HTML and truncated to 500 characters. Feed text is formatted from Firebase item objects with title, HN item URL, optional external URL, metadata, and stripped/truncated text; failed item fetches become per-item failure lines. Search details.response contains provider="hackernews-algolia", query, nbHits, and raw hits (data.hits or []). Feed details.response contains provider="hackernews-firebase", feed, count, and fetched items. Empty search hits returns a no-result text; empty feed IDs returns a no-stories text. Request errors return isError=true text, except abort/timeout errors which are rethrown.

**Hard limits**

- Schema limit is at most 50 search hits; schema count is at most 30 feed stories.
- No user-configurable request timeout; fetchJson aborts each upstream request after 15000 ms.
- Feed item requests are fetched with at most 6 concurrent workers (ITEM_CONCURRENCY=6).
- Formatted story/comment/feed text is truncated to at most 500 characters per item (MAX_SNIPPET=500).
- Feed mode only slices the first count IDs from the single Firebase list response.
- Numeric filters and since_days are sent only for positive values; values are floored when URL construction occurs where applicable.

**Verified absent**

- Does not expose an Algolia page/page-number or pagination parameter; it requests only one hitsPerPage page (while returning nbHits total).
- Does not expose full-page or full-thread extraction: search uses Algolia hit fields only, and displayed text is HTML-stripped/truncated; feed fetches individual story items only, not comments or descendant threads.
- Does not expose a feed sort option; feed selection is limited to the six fixed Firebase lists top/new/best/ask/show/job.
- Does not expose a custom feed/list endpoint or a feed offset; count always takes the first IDs from the selected Firebase list.
- Does not expose author, domain, date-range start/end, language, or other search filters beyond tags, minimum points/comments, recency, and since_days wired in the source.
- Does not expose a choice of Algolia index/API endpoint; sort is only relevance versus date, mapping to the two fixed URLs.
- Does not expose adjustable timeout, concurrency, or snippet length parameters.
- Formal schema has no mutual-exclusion rule. Runtime precedence is the only interaction: a positive since_days suppresses recency; operation=feed switches branches and ignores query/search filters, while search ignores feed/count.

### `reddit_search`

**Backend** — Requests use https://arctic-shift.photon-reddit.com/api/posts/search with query string; rendered Reddit permalinks use https://www.reddit.com as the base when the normalized permalink is relative.

**Auth** — Keyless. No Reddit or Arctic Shift credential is read. The request User-Agent resolves in this order: nonempty trimmed process.env.REDDIT_USER_AGENT, otherwise the source constant omp-extended-search:reddit_search/2.0 (personal research; arctic-shift).

**Operations**

- search (the only mode; there is no operation/mode input selector)

**Parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Optional schema field. Trimmed at execution. Required when normalized subreddits are omitted/empty and the built-in defaults are therefore used; with at least one valid named subreddit it may be omitted to retrieve recent posts. |
| `subreddits` | string[] | — | Optional schema field. Each item is trimmed; a leading r/ (case-insensitive) is stripped; nonstrings, names shorter than 2 or longer than 30 characters, empty names, and case-insensitive duplicates are discarded. If the resulting list is empty, runtime uses [LocalLLaMA, MachineLearning, ClaudeAI, OpenAI]. The description's additional ChatGPTCoding and singularity defaults are not used by source. |
| `sort` | enum: new \| top | new | Optional. new means descending created time; top means client-side descending score with created time as tie-breaker, within the fetched time window. The backend request itself always sends sort=desc. |
| `time` | enum: hour \| day \| week \| month \| year | month | Optional time window. Used only when positive finite since_days is absent and recency is absent/invalid. Mappings are hour=1/24 day, day=1, week=7, month=30, year=365. |
| `recency` | enum: day \| week \| month \| year | — | Optional alias for time. Runtime checks recency before time, so when both are supplied this field wins (unless positive finite since_days is supplied). Mapping is day=1, week=7, month=30, year=365 days. |
| `since_days` | number | — | Optional schema constraint is only >=0 (not integer and no upper bound). A positive finite value overrides recency/time and is converted to a Unix after cutoff using floor(Date.now()/1000 - value*86400); zero, non-finite, or non-number values do not override and fall through to recency/time/default. |
| `limit` | integer number | 10 | Optional; schema requires integer in [1, 50]. Runtime clamps finite numeric values to [1,50] and otherwise uses 10. Final merged output is sliced to this limit. |

**Output** — Returns either an error text object or content text plus details.response. Successful response fields are provider='arctic-shift', query (trimmed string or null), count, sort, sinceDays, subreddits, usedDefaults, errors, and posts. Each normalized post has id, title, permalink, url, score, num_comments, author, subreddit, subreddit_name_prefixed, created_utc, selftext, link_flair_text, over_18, and is_self. Human-readable text includes title, score, comment count, author, date/flair, permalink, external URL for non-self posts, and a selftext snippet truncated to 400 characters. NSFW posts and [removed] title shells are filtered; [deleted]/[removed] selftext is blanked.

**Hard limits**

- Each subreddit request is fixed at limit=25; there is no input parameter to change that upstream fetch size.
- At most 50 merged posts are returned because limit is constrained to 1-50 and the merged list is sliced.
- Subreddit requests are sequential with a 1500 ms gap between calls after the first.
- Each fetch has a 20000 ms timeout; retry occurs once only for errors matching slow down/too many/rate/timeout.
- The default time window is 30 days; positive finite since_days has no source-level maximum but the archive query still fetches only one fixed page per subreddit.
- NSFW posts are always dropped; removed-title shells are dropped.
- If all subreddits fail and no posts exist, execute returns isError; partial subreddit failures are represented in errors while successful results remain.
- The archive is explicitly documented/source-described as volunteer-run and capable of rate-limiting or timing out under load.

**Verified absent**

- Cannot perform global all-of-Reddit free-text search: source sends one subreddit parameter per request and requires a query and/or valid subreddits; omitted/empty subreddits only selects the fixed tech/AI defaults.
- Cannot request official/live Reddit ranking modes such as hot or true relevance: schema exposes only new/top; API is always called with sort=desc, and top is client-side score sorting within the fetched window.
- Cannot fetch per-thread comments or top comments: the tool only queries the posts endpoint and source/docs explicitly state that it does not fetch per-thread comments.
- Cannot return full selftext: human-readable output truncates selftext to 400 characters (normalized details retain only the source selftext string, after filtering).
- Cannot paginate or request an arbitrary archive page/window: there is no pagination/cursor/after input; source makes one fixed request per subreddit with limit=25 and no loop over pages.
- Cannot expose the raw Arctic Shift response: rows are normalized into selected post fields and errors; unknown upstream fields are discarded.
- Cannot search arbitrary Reddit entities beyond posts in the named/default subreddits: source hardcodes the /api/posts/search posts endpoint and has no comment/user/subreddit metadata mode.
- Cannot preserve NSFW results: over_18 posts are unconditionally filtered before merge/output.
- Cannot select parallel fetching, retry count, timeout, inter-request gap, User-Agent via a tool parameter, or archive endpoint: all are hardcoded except User-Agent's process environment override.

### `arxiv_search`

**Backend** — https://export.arxiv.org/api/query (constructed as `${ARXIV_API}?${qs.toString()}`; request query parameters are search_query, start=0, max_results, sortBy, sortOrder=descending)

**Auth** — No credential resolution is performed. The source documents the arXiv Atom API as free and keyless, with no credentials or environment variables required.

**Operations**

- search (implicit; there is no operation/mode input parameter)

**Parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Required by the zod input schema. At execution, it is trimmed and becomes all:"<text>"; the runtime accepts an empty/missing query only when nonblank categories or author supplies the search, otherwise returns an error. |
| `categories` | string[] | — | Optional array of strings. Values are trimmed and blank values discarded at execution. One value becomes cat:<value>; multiple values become (cat:<value> OR cat:<value> ...). No array length bound or category enum is declared. |
| `author` | string | — | Optional string. Trimmed and, when nonempty, becomes au:"<author>". |
| `sort` | "relevance" \| "date" | "relevance" (effective default) | Optional enum. relevance produces sortBy=relevance; date produces sortBy=submittedDate. sortOrder is always descending. |
| `recency` | "day" \| "week" \| "month" \| "year" | — | Optional enum. Produces a submittedDate range for the preceding 1, 7, 30, or 365 days, respectively (with an upper bound of now + 1 day). |
| `since_days` | number | — | Optional number with schema constraint >= 0; unlike max_results, it is not required to be an integer and has no declared maximum. A finite positive value produces a preceding-N-days submittedDate range and takes precedence over recency. A value of 0 passes schema validation but is treated as absent by query construction. |
| `max_results` | integer | 10 | Optional integer constrained to 1 through 50 inclusive. The URL builder also clamps the effective value to that range. |

**Output** — Returns one formatted text result (or an error text): total result count and displayed count; each displayed entry includes title, primary category and date, abstract-page URL, PDF URL, up to two author names plus a "+N more" indicator, and a cleaned abstract summary truncated to 500 characters. Also returns details.response with provider="arxiv", the original query, generated search_query, total, count, and parsed entries. Each entry has id, title, summary, published, updated, authors, categories, abs, and pdf.

**Hard limits**

- max_results is capped at 50; start is hard-coded to 0.
- Exactly one API fetch is made per call; there is no built-in pagination or multi-request continuation.
- Fetch timeout is 20,000 ms.
- Abstract summaries are truncated to 500 characters.
- The source/doc description says arXiv asks clients to stay near one request per 3 seconds; this tool does not implement throttling or retries.

**Verified absent**

- Cannot paginate or request an offset: start is always fixed to 0 and no start/page/cursor parameter is exposed.
- Cannot fetch or return full paper/full abstract-page text: it parses only the Atom response and returns a summary truncated to 500 characters, although it does expose abs and PDF links.
- Cannot choose ascending or another sort order: sortOrder is hard-coded to descending.
- Cannot specify an arbitrary submitted-date start/end range: only the relative recency enum or since_days range is wired.
- Cannot perform operations other than the single implicit search mode; no alternate operation selector is exposed.
- Cannot authenticate with a caller-supplied key or credential: the source uses the keyless endpoint without auth handling.
- Cannot validate category identifiers against an arXiv category enum: categories are accepted as arbitrary strings and inserted into the query.

### `feed_search`

**Backend** — Direct `fetch(url, ...)` of caller-supplied `urls` plus these literal bundle URLs: ai-labs = `https://openai.com/news/rss.xml`, `https://deepmind.google/blog/rss.xml`, `https://huggingface.co/blog/feed.xml`, `https://machinelearning.apple.com/rss.xml`; tech-news = `https://www.techmeme.com/feed.xml`, `https://www.theverge.com/rss/index.xml`, `https://feeds.arstechnica.com/arstechnica/index`, `https://techcrunch.com/feed/`. Requests use redirect=`follow`; there is no intermediary API endpoint.

**Auth** — No credentials are used and no environment-variable lookup exists; the tool is keyless. Each request sends a fixed browser-like User-Agent and RSS/Atom-oriented Accept header, follows redirects, and has no auth header.

**Operations**

- Custom-feed mode selected with `urls` (one or more nonblank strings after runtime trim/filter).
- Preset mode selected with `bundle` (`ai-labs` or `tech-news`). `urls` and `bundle` may be supplied together; sources are combined and exact duplicate URLs are removed.
- Optional case-insensitive AND keyword filtering selected by `query`; every whitespace-separated term must occur in the item title or truncated summary.
- Optional recency filtering selected by positive `since_days`; items with parsed dates older than the computed cutoff are removed (`since_days=0` is accepted by schema but behaves as no date filter).
- Per-feed cap selected by `per_feed_limit`, followed by a global cross-feed cap selected by `limit`. Items are always newest-first per feed, then the global cap interleaves by date.

**Parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `urls` | string[] | — | Optional Zod array of strings; no schema min length or URL-format constraint. At runtime values are stringified, trimmed, and blank values discarded. After that processing, at least one nonblank URL is required if `bundle` is absent. Custom URLs are fetched literally. |
| `bundle` | enum string | — | Optional; exact values are `ai-labs` or `tech-news`. Required when no nonblank `urls` remain. Runtime also checks the key and reports unknown bundles. Bundles may be combined with `urls`. |
| `query` | string | — | Optional; runtime trims it, lowercases it, splits on whitespace, drops empty terms, and requires every term to be a substring of lowercased title+summary. No length or term-count bound. |
| `since_days` | number | — | Optional; schema minimum is 0, with no maximum. Runtime uses it only when it is finite and strictly greater than 0; cutoff is `Date.now() - since_days * 86_400_000`. Items without a parseable date are excluded when this filter is active. |
| `limit` | integer number | 20 | Optional; schema range is 1–100 inclusive. Runtime floors finite numeric values and clamps to 1–100. |
| `per_feed_limit` | integer number | 10 | Optional; schema range is 1–25 inclusive. Runtime floors finite numeric values and clamps to 1–25. Applied independently before the global `limit`. |

**Output** — Returns text content containing a summary header, one `##` section per resolved feed, failure/no-match markers, and each item’s title, optional ISO date (`YYYY-MM-DD`), link, and cleaned summary. Also returns `details.response` with `provider: "feed_search"`, resolved source URLs, and `feeds[]`; each feed has `name`, `url`, `count`, optional `error`, and `items[]` containing `title`, `link`, `date`, and `summary`. XML is parsed as RSS 2.0 (`item`) or Atom (`entry`); summaries are HTML/entity/CData-cleaned and truncated to 400 characters.

**Hard limits**

- `limit` maximum is 100 total items; default 20.
- `per_feed_limit` maximum is 25 items per feed; default 10.
- Each feed fetch has a 12,000 ms timeout.
- At most 4 feed fetches run concurrently.
- Item summaries are truncated to 400 characters.
- No explicit upper bound is imposed by the input schema on the number of custom URLs; exact duplicate resolved URLs are removed.
- Failed individual feeds are retained as errors while other feeds continue; whole-call cancellation propagates instead of being converted to a per-feed result.

**Verified absent**

- No pagination parameter or pagination handling is wired; one fetch is made per resolved feed URL.
- No sort/order parameter is exposed; results are unconditionally sorted newest-first per feed and date-ranked for the global cap.
- No full-page/article extraction is performed: the tool fetches feed XML only and extracts feed title/link/date/description-summary-content fields; output summaries are capped at 400 characters.
- No feed-provider/API-specific controls (such as provider query syntax, categories, or provider-side sort controls) are exposed beyond the literal URL and local `query`/`since_days` filters.
- No credentials, private-mailbox/IMAP access, or authenticated/private feed access is implemented.
- ? The source does not document or implement any upstream feed pagination, continuation token, or provider metadata controls; claims about a particular feed provider’s native capabilities cannot be established from this source.

### `github_search`

**Backend** — https://api.github.com/search/repositories (GET via fetch); authentication fallback also invokes host.exec("gh", ["auth", "token"], {}) when env credentials absent

**Auth** — Credential resolution order: first nonblank process.env.GITHUB_TOKEN, then process.env.GH_TOKEN (the expression selects GITHUB_TOKEN before GH_TOKEN); if neither is present, host.exec("gh", ["auth", "token"], {}) is attempted and a successful code 0 with nonblank stdout is used; otherwise keyless unauthenticated fetch proceeds. Token is sent as Authorization: Bearer <token>. Requests also send Accept: application/vnd.github+json, X-GitHub-Api-Version: 2022-11-28, and User-Agent: omp-extended-search.

**Operations**

- Repository search: builds one GitHub REST Search API request from query/qualifiers and returns formatted repository results plus raw item details.

**Parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Optional. Trimmed; if nonblank added as free-text query. The request may omit it only if at least one supported qualifier produces a nonempty query. |
| `created_after` | string | — | Optional schema string; runtime nonempty value must match exact YYYY-MM-DD, otherwise execute returns an error. Adds created:>=DATE. Takes precedence over recency when both are supplied; empty string is treated as absent by runtime. |
| `created_before` | string | — | Optional schema string; runtime nonempty value must match exact YYYY-MM-DD, otherwise execute returns an error. Adds created:<=DATE; empty string is treated as absent. |
| `pushed_after` | string | — | Optional schema string; runtime nonempty value must match exact YYYY-MM-DD, otherwise execute returns an error. Adds pushed:>=DATE; empty string is treated as absent. |
| `recency` | enum("day"\|"week"\|"month"\|"year") | — | Optional. Used only when created_after is absent; computes created_after as current time minus 1, 7, 30, or 365 days respectively, formatted YYYY-MM-DD. |
| `min_stars` | integer number | — | Optional; schema range >=0 with no upper bound. Runtime adds stars:>=floor(value) only when finite and >0; 0 therefore produces no stars qualifier. |
| `language` | string | — | Optional. Trimmed nonblank value adds language:X; values containing spaces are encoded as language:"X". |
| `topics` | array of strings | — | Optional. Each trimmed nonblank element adds topic:X; qualifiers are joined with AND semantics. Empty/non-string elements are ignored at runtime (schema itself requires strings). |
| `sort` | enum("stars"\|"forks"\|"updated"\|"best_match") | best_match | Optional. Invalid/absent runtime value falls back to best_match (schema rejects invalid enum). For stars, forks, or updated, URL includes sort=<value>&order=desc; best_match omits both URL parameters. |
| `limit` | integer number | — | Optional schema range 1–50; runtime default is 10 and clamps to 1–50. Sent as GitHub per_page; no page input. |

**Output** — Returns {content:[{type:"text",text}],details:{response:{provider:"github-search",query,total_count,authenticated,rate_limit_remaining,items}}}; text reports total matches and shown count, then each item’s full_name, stars, forks, language, created date, pushed date, html URL, optional description, and optional topics. Empty results still report total and shown 0. If unauthenticated, text appends a rate-limit note; if x-ratelimit-remaining <5, appends a warning. Non-abort errors return isError:true with text "Error: ..."; abort/timeout errors are rethrown.

**Hard limits**

- Single request/page only: URL sets per_page but never page; limit is capped at 50.
- Fixed fetch timeout of 15,000 ms; no timeout parameter.
- Docs state unauthenticated use is limited to 10 requests/minute and authenticated use to 30/minute; HTTP 403/429 are surfaced as rate-limit errors.
- Only one endpoint/request is issued per execute call; no pagination or multi-request mode.

**Verified absent**

- Does not expose a pagination/page parameter or retrieve pages beyond the single first API page.
- Does not perform full-page, file, code, issue, pull-request, user, or other content extraction; it calls only /search/repositories and returns repository search fields/items.
- Does not expose ascending order: non-best_match sorts always hardcode order=desc, while best_match omits sort/order.
- Does not expose caller control over GitHub API version, headers, endpoint, timeout, or rate-limit behavior.
- Does not offer separate operations for code, issues, users, commits, or other GitHub Search API resources; docs explicitly scope it to repositories only.

### `producthunt_search`

**Backend** — https://api.producthunt.com/v2/api/graphql (POST; JSON body contains the fixed POSTS_QUERY and variables)

**Auth** — Requires a nonblank PRODUCTHUNT_API_TOKEN from process.env; value is trimmed before Bearer authorization. No keyless mode or alternate credential resolution. Source explicitly requires the Product Hunt Developer Token, not API Key/API Secret.

**Operations**

- Fetch Product Hunt posts/launches; no separate operation selector. The fixed GraphQL query requests posts ordered by VOTES or NEWEST, optionally filtered by topic and postedAfter date.

**Parameters**

| Param | Type | Default | Notes |
|---|---|---|---|
| `topic` | string | — | Optional topic slug filter; source performs String(...).trim() and only sends non-empty trimmed values. No enum or length constraint in schema. |
| `order` | enum | — | Optional; exact values: "votes" \| "newest". Runtime maps only "newest" to GraphQL NEWEST; every other/omitted value maps to VOTES. Description says votes is default. |
| `recency` | enum | — | Optional; exact values: "day" \| "week" \| "month" \| "year". Runtime maps to postedAfter windows of 1, 7, 30, or 365 days respectively. |
| `since_days` | number | — | Optional schema minimum 0 (not restricted to integer). Runtime uses it only when finite and > 0; fractional values are accepted and converted to an exact milliseconds offset. A valid >0 since_days takes precedence over recency. A value of 0 passes schema but is not used as a window; if recency is also supplied, runtime falls back to recency. |
| `limit` | integer number | 10 | Optional; schema requires integer, min 1, max 20. Runtime clampInt floors finite numeric values and clamps to [1,20], with fallback 10 for non-number/non-finite (normally schema rejects those). Sent as GraphQL first. |

**Output** — On success, content is one text block formatted as "N launches:" followed by numbered launches. Each item includes name (or "(untitled)"), optional tagline, votes and comments counts (normalized to integer display), optional ISO date (YYYY-MM-DD), optional topic names (up to the 5 topics requested by the GraphQL query), and optional Product Hunt post URL and product website. details.response contains provider="producthunt-graphql", GraphQL order (VOTES/NEWEST), topic (trimmed string or null), postedAfter ISO timestamp or null, count, and posts containing the selected raw GraphQL node fields: id, name, tagline, url, votesCount, commentsCount, createdAt, website, topics. Missing/invalid edges are filtered out. Empty results return "0 launches:\n(no matching Product Hunt launches)".

**Hard limits**

- limit is capped at 20; one request only and no pagination input is exposed.
- The GraphQL query requests at most 5 topics per post (topics(first: 5)).
- Each upstream request has a 15,000 ms timeout via AbortController.
- Only one fixed posts query is issued per execution; no batching or pagination loop.
- Results are limited to fields selected in POSTS_QUERY; count is the number of returned valid nodes, which may be below requested first.

**Verified absent**

- Cannot full-text keyword-search products; source/docs explicitly state Product Hunt v2 has no full-text search and the tool exposes only topic slug and date filtering.
- Cannot expose cursor/offset pagination or fetch subsequent pages: the fixed query has only first/order/topic/postedAfter variables and no after/cursor/page parameter or pagination loop.
- Cannot choose an arbitrary result count above 20.
- Cannot select any sort beyond the wired votes/newest enum (no other order values are accepted by the input schema).
- Cannot request arbitrary GraphQL fields, alternate Product Hunt API endpoints, or a different GraphQL operation; query and selected output fields are hard-coded.
- Cannot retrieve more than the first 5 topics per post because the fixed selection uses topics(first: 5).
- Cannot use API Key/API Secret or keyless authentication; execution only resolves PRODUCTHUNT_API_TOKEN and requires a nonblank token.
- Cannot request full-page product/site content or perform content extraction; output contains metadata plus URLs only.

## Recommended order

1. **Parallel task cancellation** on timeout/abort (`small`) — orphaned runs bill us today.
2. **Product Hunt session auth** (`small`) — `producthunt_search.ts:175-182`, add `authStorage` before the env read.
3. **Shared retry wrapper** honoring `Retry-After` with bounded jitter (`medium`) — nine of ten tools fail hard on a transient 429.
4. **arXiv process-wide limiter** (`small`).
5. **`firecrawl_crawl` / `site_crawl`** (`medium`) — we pay for Firecrawl and wire 1 of its 4 useful endpoints. `/map` + `/crawl` + `/scrape` close the crawl gap for public sites at a fraction of the cost of hand-rolled BFS. It does **not** close authenticated crawling: Firecrawl passes no cookies, so behind-login remains `xd://browser`'s job.
6. **Pagination wiring** — arXiv `start`, GitHub `page`, HN `page` are one line each; then normalized `has_more` / `upstream_total` everywhere.

Deliberately deferred: the workflow layer (fan-out orchestrator, persistent result store, watch service, canonical citation model). Real, `large`, and largely duplicated by the `eval` / `task` / `parallel` harness — this audit was itself a 10-way fan-out with merge and adversarial verification, written in two cells. Build it on the third repetition of the same glue.

**Open item** — `install.sh` copies, is strictly opt-in, and never re-runs. It will not discover any tool added above, exactly as it failed to discover `firecrawl_search` for four days.