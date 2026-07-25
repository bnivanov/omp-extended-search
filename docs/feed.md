# feed_search

Reads RSS 2.0 and Atom feeds — news sites, company blogs, newsletters. Free, keyless — no credentials, no env vars.

This is the newsletter answer: you do not need email access. Substack, Medium, and basically every blog publish a feed; free posts come through in full.

## Parameters

| Parameter | Type | Notes |
|---|---|---|
| `urls` | string[] | Feed URLs to fetch. |
| `bundle` | `ai-labs` \| `tech-news` | Preset feed lists. Required when `urls` is absent. |
| `query` | string | Keyword filter over title + summary. All whitespace-separated terms must match (case-insensitive). |
| `since_days` | number | Only items newer than N days. |
| `limit` | int 1–100 | Max items total across feeds, default 20. Applied **after** `per_feed_limit`. |
| `per_feed_limit` | int 1–25 | Max items kept **per feed before** the global `limit`, default 10. |

## Bundles

- **ai-labs** — OpenAI (`openai.com/news/rss.xml`), Google DeepMind (`deepmind.google/blog/rss.xml`), Hugging Face (`huggingface.co/blog/feed.xml`), Apple ML (`machinelearning.apple.com/rss.xml`)
- **tech-news** — Techmeme, The Verge, Ars Technica, TechCrunch

Not every lab publishes a feed — Anthropic, Meta AI, and Mistral have none we could find (checked July 2026).

## Constructing feed URLs

The model can build these on the fly:

- **Substack**: `https://<name>.substack.com/feed` — free posts full text, paid posts truncated
- **Medium**: `https://medium.com/feed/@<user>`, `/feed/<publication>`, `/feed/tag/<tag>`
- **Google News**: `https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en`

## Enclosures / media

RSS `<enclosure url type length>` and Atom `<link rel="enclosure" href …>` are parsed into an `enclosures` array on each item (url + optional type/length). Nothing is downloaded — metadata only. In the text output they surface as a `media:` line under the item; the structured `details.response.feeds[].items[].enclosures` carries the same data.

## Pagination

No page/cursor parameter (`continuation_supported: false`). Raise `limit` / `per_feed_limit` or narrow `query` / `since_days` instead of asking for another page.

- `per_feed_limit` is applied first (per feed, newest-first after filters); then the global `limit` interleaves remaining items by date across feeds.
- When a feed loses items to `per_feed_limit`, its name appears in `details.pagination.per_feed_truncated`, and the trailing line lists those feeds.
- `details.pagination` also includes `per_feed` (kept counts) and `per_feed_candidates` (pre-slice counts) for debugging rich feeds.

## Notes

- Best-effort across feeds: **one dead feed URL never fails the whole call**. A feed that errors or times out is marked `(failed: …)` with the error kept per-feed; the others still return.
- Items are sorted newest-first per feed; the global `limit` interleaves by date across feeds.
- Per-feed fetches retry transient HTTP/transport failures with bounded exponential jitter (honoring `Retry-After` against the remaining deadline); retryable statuses include `500` (unbilled GETs). Aborts normalize to `AbortError`; a per-feed timeout stays per-feed, while a whole-call abort still cancels the run.
- For actual email-only newsletters there's no shortcut — they'd need IMAP into a mailbox, which isn't worth the plumbing. RSS bridges (e.g. Kill the Newsletter) exist if you ever need one.
