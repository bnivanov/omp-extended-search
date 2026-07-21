# producthunt_search

Fetches Product Hunt launches via the official GraphQL API.

One honest limitation up front: **the Product Hunt v2 API has no full-text search.** This tool lists recent or top launches filtered by topic and date — it cannot keyword-search products.

## Prerequisites (one-time)

1. Create an app at https://www.producthunt.com/v2/oauth/applications
2. Use its developer token / API key:

```bash
export PRODUCTHUNT_API_TOKEN=...
```

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
