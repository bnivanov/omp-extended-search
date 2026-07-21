# producthunt_search

Fetches Product Hunt launches via the official GraphQL API.

One honest limitation up front: **the Product Hunt v2 API has no full-text search.** This tool lists recent or top launches filtered by topic and date — it cannot keyword-search products.

## Prerequisites (one-time)

1. Create an app at https://www.producthunt.com/v2/oauth/applications
2. On the app page, find **Developer Token** (or "Create Developer Token") — **not** the API Key / API Secret pair.
3. Export that token:

```bash
export PRODUCTHUNT_API_TOKEN=...   # the Developer Token string
```

### Common mix-up

Product Hunt shows three different secrets on the app page:

| Field | Use it? |
|---|---|
| **API Key** | No — this alone does not authorize GraphQL calls |
| **API Secret** | No — only used if you build a full OAuth flow |
| **Developer Token** / Token | **Yes** — this is what `PRODUCTHUNT_API_TOKEN` wants |

If you export the API Key by mistake you'll get `invalid_oauth_token`. Grab the Developer Token instead (yours can be set to never expire).

## Parameters

| Parameter | Type | Notes |
|---|---|---|
| `topic` | string | Topic slug, e.g. `artificial-intelligence`, `developer-tools`, `tech`, `productivity`, `design-tools`. |
| `order` | `votes` \| `newest` | Default `votes` (the week's top launches). |
| `recency` | `day` \| `week` \| `month` \| `year` | Only launches since then. |
| `since_days` | number | Only launches from the last N days (overrides `recency`). |
| `limit` | int 1–20 | Default 10. |

## Notes

- Results include name, tagline, vote and comment counts, launch date, the Product Hunt post URL, the product's own website, and topics.
- "Top AI launches this week" ≈ `topic: "artificial-intelligence"`, `order: "votes"`, `recency: "week"`.
