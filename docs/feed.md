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
| `limit` | int 1–100 | Max items total across feeds, default 20. |
| `per_feed_limit` | int 1–25 | Max items per feed, default 10. |

## Bundles

- **ai-labs** — OpenAI (`openai.com/news/rss.xml`), Google DeepMind (`deepmind.google/blog/rss.xml`), Hugging Face (`huggingface.co/blog/feed.xml`), Apple ML (`machinelearning.apple.com/rss.xml`)
- **tech-news** — Techmeme, The Verge, Ars Technica, TechCrunch

Not every lab publishes a feed — Anthropic, Meta AI, and Mistral have none we could find (checked July 2026).

## Constructing feed URLs

The model can build these on the fly:

- **Substack**: `https://<name>.substack.com/feed` — free posts full text, paid posts truncated
- **Medium**: `https://medium.com/feed/@<user>`, `/feed/<publication>`, `/feed/tag/<tag>`
- **Google News**: `https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en`

## Notes

- Best-effort: a feed that fails or times out is marked `(failed: …)` and the rest still come back.
- Items are sorted newest-first per feed; the global `limit` interleaves by date across feeds.
- For actual email-only newsletters there's no shortcut — they'd need IMAP into a mailbox, which isn't worth the plumbing. RSS bridges (e.g. Kill the Newsletter) exist if you ever need one.
