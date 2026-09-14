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

Server enum (Mar-2026): `instant | fast | auto | deep-lite | deep | deep-reasoning`. `neural`/`keyword` are **removed server-side** — the tool maps `keyword` → `fast` client-side; never send `neural` (400 risk).

| Type | Latency (typical) | Price (Mar-2026) | Use when |
|---|---|---|---|
| `instant` | fastest | $7/1k base | Pure keyword-style lookup |
| `fast` | ~0.3–5s | $7/1k base | Cheap/quick lookups (`keyword` maps here) |
| `auto` *(default)* | ~1–5s | $7/1k base | Default quality; Exa picks the retrieval path |
| `deep-lite` | deeper, seconds+ | **$12/1k** | Structured multi-angle work on a budget |
| `deep` | ~4–12s+ | deep tier (see pricing page) | Multi-angle expansion for hard research questions |
| `deep-reasoning` | slowest | **$15/1k** | Hardest questions; reasoning-heavy synthesis |

Search pricing (Mar-2026 overhaul — https://exa.ai/docs/reference/pricing.md): **$7/1k for ≤10 results** (text+highlights bundled), **+$1/1k above 10**. Grounded synthesis (`output_schema`/`system_prompt`) adds synthesis cost on top of search (~+2s latency). Free tier: $10/mo.

## Contents packing

How much page body you pay for per result. **Billing is per content type** (Mar-2026): every requested type bills **$1/1k**, so requesting `text` + `highlights` together = double-billing.

| `contents` | Meaning | Bill |
|---|---|---|
| `summary` *(default)* | Per-result summary focused on the query | 1 content type |
| `highlights` | Query-relevant snippet sentences — cap with `highlights_max_characters` (ours ≤5000) | 1 content type |
| `text` | Longer extracted page text — cap with `text_max_characters` (ours ≤10000 = API max) | 1 content type |
| `all` | summary + highlights + text | 3 content types |
| `none` | Links/metadata only | — |

Per-result body options (search op): `subpages` (0–100) + `subpage_target` fetch child pages; `extras` (`links`/`imageLinks`/`codeBlocks`) adds link/metadata payloads. Deprecated highlight knobs are gone: `highlights_per_url` (ignored server-side), `highlights_num_sentences` (removal-slated), and oversized `text_max_characters` (our zod caps at the API max 10000).

## Categories (vertical indexes)

Optional `category` restricts to an Exa vertical:

`company`, `publication`, `news`, `personal site`, `people`, `financial report`

Legacy values the tool handles or drops: `research paper` → mapped to `publication` client-side; `pdf` / `github` / `tweet` are deprecated — never send them (400 risk). `company`/`people` categories reject published-date bounds and `exclude_domains` server-side — don't combine them.

## Filters

- `include_domains` / `exclude_domains` (not with `company`/`people` categories — rejected server-side)
- `start_published_date` / `end_published_date` — page published-date bounds
- `additional_queries` (ours ≤10 = API max; deep types only) — extra query angles
- `user_location` — ISO country bias, e.g. `US`
- `moderation` — moderation preference
- `max_age_hours` (ours 0–720 = API max) — freshness preference; replaces the deprecated `livecrawl` (which the tool no longer sends)

Removed and no longer sent anywhere: `start_crawl_date`/`end_crawl_date` (ignored since 2026-04-15), `include_text`/`exclude_text` (absent from the current SearchRequest schema).

## Answer operation

`operation: "answer"` with a `query` returns a synthesized paragraph + citations for one factual question — **$5/1k** (verified current, Mar-2026). Options: `model` (`exa` | `exa-pro` | `exa-research` | `exa-fast`), `text: true` (source text alongside citations), `system_prompt`, `output_schema`, `user_location`.

## Contents operation

`operation: "contents"` with `urls` fetches/parses known pages through Exa — up to **100 URLs** (upstream limit; the tool matches it since the old 20-URL clamp was raised). It always requests `text` + `highlights` → **two content types billed per URL**; add `query` for a focused summary per URL (a third type).

## Pagination

None of the three operations paginate — `details.pagination` always reports `continuation_supported: false` (no page/cursor parameter).

- **`search`** — one shot up to `num_results` / `limit` (max 100). When the result set may be truncated, the trailing line says so and tells you to raise the limit or narrow the query.
- **`answer`** / **`contents`** — no result-limit knob, so neither emits a truncation warning. `answer` returns one synthesized paragraph + citations; `contents` returns whatever Exa has for the URLs you passed (≤100).

## Resilience

All three endpoints are billed POSTs. Transient failures retry with bounded exponential jitter (honoring `Retry-After` against the remaining deadline). Retryable statuses: `408` / `425` / `429` / `502` / `503` / `504`, plus pre-response transport errors. **`500` is deliberately excluded** — the server may already have billed. Aborts normalize to `AbortError`; the tool timeout interrupts a retry backoff.

## Environment defaults

| Env | Default | Effect |
|---|---|---|
| `EXA_API_KEY` | — | Auth fallback after the omp session key |
| `OMP_EXA_DEFAULT_TYPE` | `auto` | Default search `type` (`instant|fast|auto|deep-lite|deep|deep-reasoning`; `keyword` maps to `fast`) |
| `OMP_EXA_DEFAULT_NUM_RESULTS` | `10` | Default result count |
| `OMP_EXA_DEFAULT_CONTENTS` | `summary` | Default contents packing |

## What it's not

- Not an X/Twitter search (use `x_search` for Grok synthesis, `x_api` for operators/metrics)
- Not a multi-minute research report (use `parallel_search` `operation=task`)
- omp's `exa.enableResearcher` / `exa.enableWebsets` config toggles are unrelated — they currently register no tools
