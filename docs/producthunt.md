# producthunt_search

Fetches Product Hunt launches via the official GraphQL API.

One honest limitation up front: **the Product Hunt v2 API has no full-text search.** This tool lists recent or top launches filtered by topic and date — it cannot keyword-search products.

## Prerequisites (one-time)

1. Create an app at https://www.producthunt.com/v2/oauth/applications
2. On the app page, find **Developer Token** (or "Create Developer Token") — **not** the API Key / API Secret pair.
3. Provide that token via one of (first match wins):

```bash
# preferred for agents: omp session credential under either id
#   producthunt  or  product-hunt
export PRODUCTHUNT_API_TOKEN=...   # Developer Token string
# also accepted:
export PRODUCT_HUNT_TOKEN=...
```

**Credential resolution order:** omp session `authStorage.getApiKey("producthunt")`, then `getApiKey("product-hunt")`, then env `PRODUCTHUNT_API_TOKEN`, then env `PRODUCT_HUNT_TOKEN`.

### Common mix-up

Product Hunt shows three different secrets on the app page:

| Field | Use it? |
|---|---|
| **API Key** | No — this alone does not authorize GraphQL calls |
| **API Secret** | No — only used if you build a full OAuth flow |
| **Developer Token** / Token | **Yes** — this is what the session credential / `PRODUCTHUNT_API_TOKEN` / `PRODUCT_HUNT_TOKEN` want |

If you export the API Key by mistake you'll get `invalid_oauth_token`. Grab the Developer Token instead (yours can be set to never expire).

## Parameters

| Parameter | Type | Notes |
|---|---|---|
| `topic` | string | Topic slug, e.g. `artificial-intelligence`, `developer-tools`, `tech`, `productivity`, `design-tools`. |
| `order` | `votes` \| `newest` | Default `votes` (the week's top launches). |
| `recency` | `day` \| `week` \| `month` \| `year` | Only launches since then. |
| `since_days` | number | Only launches from the last N days (overrides `recency`). |
| `limit` | int 1–20 | Default 10. |
| `after` | string | Opaque cursor from a previous response’s `pagination.next` (`pageInfo.endCursor`). Pass it back as `after` for the next page. **There is no page number** for this tool. |

## Notes

- Results include name, tagline, vote and comment counts, launch date, the Product Hunt post URL, the product's own website, and topics.
- "Top AI launches this week" ≈ `topic: "artificial-intelligence"`, `order: "votes"`, `recency: "week"`.
- **Pagination:** cursor-based via GraphQL `after` + `pageInfo.endCursor`. `details.pagination` is `{ per_page, returned, has_more, continuation_supported, next? }` — **no `page` field**. `continuation_supported: true`; when `has_more`, `next` is the end cursor to pass back as `after` (never invent a numeric page). Text ends with a `Showing N of …` line and `; more available — pass after: "…"` when applicable.
- **Retries:** bounded exponential jitter (up to 3 attempts) on the GraphQL POST. Retryable statuses are 408/425/429/500/502/503/504 plus pre-response transport errors (`500` stays retryable here — unbilled developer-token list, not a billed search-credit endpoint). `Retry-After` is honored against the remaining deadline. Aborts normalize to `AbortError`; the tool timeout interrupts a retry backoff.
