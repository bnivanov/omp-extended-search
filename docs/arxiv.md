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
| `max_results` | int 1–50 | Default 10. |

## Notes

- Every result includes the abstract page link, the PDF link, authors, primary category, and submission date.
- The tool makes one API request per call. arXiv asks clients to stay under ~1 request per 3 seconds; hammering it gets the whole IP a temporary 429.
- The summary shown is the abstract, truncated to ~500 characters — enough to triage; fetch the abs page for the full text.
