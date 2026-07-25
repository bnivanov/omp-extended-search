# arxiv_search

Searches arXiv papers via the official arXiv API. Free, keyless — no credentials, no env vars. For latest AI research this is the primary source: cs.AI, cs.LG, cs.CL, cs.MA, stat.ML and friends.

## Parameters

| Parameter | Type | Notes |
|---|---|---|
| `query` | string *(required)* | Free text; matched against titles, abstracts, authors. |
| `categories` | string[] | Restrict to categories, e.g. `["cs.LG", "cs.CL"]`. ORed. |
| `author` | string | Author name filter. |
| `sort` | `relevance` \| `date` | Default `relevance`; `date` = most recently submitted first. |
| `recency` | `day` \| `week` \| `month` \| `year` | Only papers submitted in that window. |
| `since_days` | number | Only papers from the last N days (overrides `recency`). |
| `max_results` | int 1–50 | Default 10. Page size (`per_page`). |
| `page` | int ≥ 1 | 1-indexed page (default 1). Mapped to the API as `start = (page - 1) * max_results`. |

## Notes

- Every result includes the abstract page link, the PDF link, authors, primary category, and submission date.
- Requests are **serialized and spaced** process-wide to ~1 request / 3 s (arXiv's rate policy), **including retries**. The admission queue is bounded (~32 waiters); under heavy concurrency an overflow error is possible (`arXiv request queue is full`). Do not assume a single unthrottled request per call — concurrent callers share the gate.
- **Pagination:** `details.pagination` is `{ page, per_page, returned, upstream_total?, has_more, continuation_supported, next? }`. `upstream_total` comes from Atom `opensearch:totalResults`. `continuation_supported: true`; when `has_more`, `next` is `page + 1`. Text output ends with a human-readable `Showing N of T (page P)` line (and `; more available — request page: P+1` when applicable).
- **Retries:** bounded exponential jitter (up to 3 attempts). Retryable statuses are 408/425/429/500/502/503/504 plus pre-response transport errors; `Retry-After` is honored against the remaining deadline. Aborts normalize to `AbortError`; the tool timeout interrupts a retry backoff.
- The summary shown is the abstract, truncated to ~500 characters — enough to triage; fetch the abs page for the full text.
