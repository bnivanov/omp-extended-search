# exa_search

Full Exa API for omp: `POST /search`, `POST /answer`, and `POST /contents` against `https://api.exa.ai`. omp's built-in Exa path only ever uses `type=auto` + summary and exposes no filters — this tool exposes the practical surface.

Credentials: `/login` → Exa, or `EXA_API_KEY`. Session key first, env var as fallback.

## Operations

| `operation` | Endpoint | What it does |
|---|---|---|
| `search` *(default)* | `POST /search` | Ranked web results with optional contents |
| `answer` | `POST /answer` | Short grounded answer + citations |
| `contents` | `POST /contents` | Fetch/parse known URLs through Exa (needs `urls`) |

## Search `type` (the main knob)

| Type | Latency (typical) | Cost (observed, ~5–10 hits) | Use when |
|---|---|---|---|
| `auto` *(default)* | ~1–5s | ~$0.007 + ~$0.005–0.01 with summary | Default quality; Exa picks the retrieval path |
| `fast` | ~0.3–5s | similar to auto in practice | Speed / cheap keyword-ish lookups. (`keyword` and `instant` are aliases) |
| `neural` | ~1–5s | ~$0.007 + contents | Pure semantic similarity — "pages that mean X" |
| `deep` | ~4–12s+ | ~$0.012 + contents (~$0.017–0.022 with summary) | Multi-angle expansion for hard research questions |

Observed costs come from live `costDollars` readings (July 2026), not marketing pages. Your plan may differ.

## Contents packing

How much page body you pay for per result:

| `contents` | Meaning | Cost |
|---|---|---|
| `summary` *(default)* | Per-result summary focused on the query | Mid — usually worth it for agents |
| `highlights` | Query-relevant snippet sentences | Mid |
| `text` | Longer extracted page text | Higher |
| `all` | summary + highlights + text | Highest |
| `none` | Links/metadata only | Lowest |

Fine-tuning: `summary_query`, `highlights_query`, `highlights_per_url` (1–10), `highlights_num_sentences` (1–20), `text_max_characters` (100–50000).

## Categories (vertical indexes)

Optional `category` restricts to an Exa vertical:

`company`, `people`, `research paper`, `news`, `pdf`, `github`, `personal site`, `financial report`, `tweet`

Use when you know the entity type — they beat generic web noise.

## Filters

- `include_domains` / `exclude_domains`
- `start_published_date` / `end_published_date` — page published-date bounds
- `start_crawl_date` / `end_crawl_date` — Exa crawl-date bounds
- `include_text` / `exclude_text` (≤5 phrases) — require/exclude phrases on the page
- `additional_queries` (≤5) — extra query angles, pairs well with `type=deep`
- `user_location` — ISO country bias, e.g. `US`
- `moderation`, `livecrawl`, `max_age_hours` — freshness/moderation preferences

## Answer operation

`operation: "answer"` with a `query` returns a synthesized paragraph + citations for one factual question (~$0.005 observed). `text: true` includes source text alongside citations.

## Contents operation

`operation: "contents"` with `urls` (≤20) fetches/parses those pages through Exa. Always requests text + highlights; add `query` to also get a focused summary per URL.

## Environment defaults

| Env | Default | Effect |
|---|---|---|
| `EXA_API_KEY` | — | Auth fallback after the omp session key |
| `OMP_EXA_DEFAULT_TYPE` | `auto` | Default search `type` |
| `OMP_EXA_DEFAULT_NUM_RESULTS` | `10` | Default result count |
| `OMP_EXA_DEFAULT_CONTENTS` | `summary` | Default contents packing |

## What it's not

- Not an X/Twitter search (use `x_search`)
- Not a multi-minute research report (use `parallel_search` `operation=task`)
- omp's `exa.enableResearcher` / `exa.enableWebsets` config toggles are unrelated — they currently register no tools
