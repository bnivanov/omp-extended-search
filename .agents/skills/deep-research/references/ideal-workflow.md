# Plan construction

This is **not** a cost ladder you must climb. Use it when estimating the **Chosen** mix.

1. Open `capability-catalog.md`. List every capability that can answer the angles.
2. Prefer the actual corpus at $0 when it exists (arXiv, OpenAlex, HN, GitHub repos, FRED, EDGAR, Wikipedia, Jina/`read`).
3. Add a paid/explicit lane only when the corpus or knobs require it (Exa neural, Firecrawl developer/papers, Tavily answer, X).
4. Name ceilings in the plan: Firecrawl page `limit`, agent `max_credits`, Parallel processor.
5. Write Chosen vs Rejected vs Cost (guidance, not a quote) plus numbered **How to proceed** options in the **visible** message. Do not call `ask`. Stop and wait for a reply.

## Guidance bands (not quotes)

| Band | Typical mix | When it is enough |
|---|---|---|
| $0 | `read` / Jina / Wikipedia / OpenAlex / PubMed / arXiv / HN / Reddit / GitHub repos / feeds / Wayback / Bluesky | Corpus is a primary API or a URL you have |
| ≲ $0.05 / a few credits | Tavily basic; Exa auto/fast; Parallel turbo/basic; Firecrawl search/developer without scrape | Factoid, news pulse, code-issue search |
| ≲ $0.10 | Tavily advanced; Exa deep; Parallel core; Firecrawl map + few scrapes | Comparison, docs site sample |
| Named budget | Parallel pro+; Firecrawl crawl >20 pages; Firecrawl agent | User approved the ceiling |

Parallel `task` cannot be cancelled. Firecrawl `POST /crawl` and agent starts are not retried. Do not start those in the plan turn.

## After the hunt

One-line score: win / mixed / fail · best capability · worst · one lesson.
