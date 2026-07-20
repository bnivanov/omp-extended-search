# Exa & Parallel search modes guide

This document explains every mode exposed by **omp-search** (`exa_search`, `parallel_search`), when to pick each one, and how they differ from each other and from omp’s built-in `web_search`.

Last validated against live APIs: **2026-07-20**.

---

## Mental model

| Tool | Best at | Returns | Cost shape |
|---|---|---|---|
| **omp `web_search`** | Everyday lookup via whichever provider is configured (`brave` on many machines) | Short answer + thin snippets | Varies by provider; modes not selectable |
| **`exa_search`** | Semantic / neural retrieval, vertical indexes (papers, people, companies, github), optional deep multi-angle search, cited answers | Ranked pages + summaries/highlights/text; or a short answer | Per-search + optional summary/text |
| **`parallel_search`** | Objective + multi-query retrieval with long LLM-ready excerpts; extract; deep research synthesis | Long excerpts; or a researched report | Per search mode tier, or per task processor |

Use them together when the user says things like:

- *“use Exa for search”* → `exa_search`
- *“use Parallel for search”* → `parallel_search`
- *“normal web search, then expand with Exa and Parallel”* → `web_search` + both tools

---

## Exa (`exa_search`)

API base: `https://api.exa.ai`

### Operations

| `operation` | Endpoint | What it does |
|---|---|---|
| `search` *(default)* | `POST /search` | Ranked web results with optional contents |
| `answer` | `POST /answer` | Short grounded answer + citations |
| `contents` | `POST /contents` | Fetch/parse known URLs through Exa |

### Search `type` (the main mode knob)

| Type | Latency (typical) | Cost (observed, ~5–10 hits) | Use when |
|---|---|---|---|
| **`auto`** *(default)* | ~1–5s | ~$0.007 search + ~$0.005–0.01 if summary | Default quality. Exa picks the retrieval path. |
| **`fast`** | ~0.3–5s | similar to auto neural in practice | Speed / cheap keyword-ish lookups. (`keyword` and `instant` aliases map here.) |
| **`neural`** | ~1–5s | ~$0.007 + contents | Pure semantic similarity — good for “pages like this meaning”, not boolean keyword ops. |
| **`deep`** | ~4–12s+ | ~$0.012 base + contents (~$0.017–0.022 with summary) | Multi-angle expansion. Harder research questions; fewer false-narrow misses. |

> Observed costs come from live `costDollars` on this workspace’s key (2026-07-20), not marketing pages. Your plan may differ.

### Contents packing (`contents`)

Controls how much page body you pay for and receive:

| Value | Meaning | Cost impact |
|---|---|---|
| `summary` *(default)* | Per-result summary focused on the query | Mid — usually worth it for agents |
| `highlights` | Query-relevant snippets | Mid |
| `text` | Longer extracted text | Higher |
| `all` | summary + highlights + text | Highest |
| `none` | Links/metadata only | Lowest |

### Categories (vertical indexes)

Optional `category`:

- `company`, `people`, `research paper`, `news`, `pdf`, `github`, `personal site`, `financial report`, `tweet`

Use these when you know the entity type — they beat generic web noise.

### Filters worth using

- `include_domains` / `exclude_domains`
- `start_published_date` / `end_published_date` (and crawl-date variants)
- `include_text` / `exclude_text`
- `additional_queries` — extra angles (pairs well with `deep`)
- `user_location` — country bias

### Answer operation

`operation: "answer"` is cheaper/faster for **one factual question** when you want a synthesized paragraph + citations (~$0.005 observed) rather than raw SERP-style results.

### What Exa is *not*

- Not a general X/Twitter firehose (use `x_search`)
- Not a multi-minute research agent report (Parallel `operation=task` or a research agent skill)
- omp’s dead settings `exa.enableResearcher` / `exa.enableWebsets` are **not** this tool — those native toggles currently register nothing

---

## Parallel (`parallel_search`)

API base: `https://api.parallel.ai` — this tool uses **V1** Search/Extract/Task (not the limited beta subset omp native hardcodes).

### Operations

| `operation` | Endpoint | What it does |
|---|---|---|
| `search` *(default)* | `POST /v1/search` | Objective + keyword queries → ranked URLs with long excerpts |
| `extract` | `POST /v1/extract` | Excerpts / full content for known URLs (≤20) |
| `task` | `POST /v1/tasks/runs` + poll | Deep Research processor — multi-step browse + synthesis |

### Search `mode`

Official V1 modes ([docs](https://docs.parallel.ai/search/modes)):

| Mode | Latency (docs / measured) | List price (10 results / 1k req) | ≈ per call | Use when |
|---|---|---|---|---|
| **`turbo`** | ~200ms / ~0.6s | $1 / 1k | **~$0.001** | High-volume, low-latency, “good enough” retrieval |
| **`basic`** | ~1s / ~1.2s | $5 / 1k | **~$0.005** | Everyday agent search; 2–3 solid keyword queries |
| **`advanced`** *(default)* | ~3s / ~1.8s | $5 / 1k | **~$0.005** | Higher-quality retrieval + compression; complex objectives |

Aliases accepted by this tool (mapped to V1):

| Alias | Maps to |
|---|---|
| `fast`, `one-shot`, `one-shot-new` | `basic` |
| `agentic`, `research`, `comprehensive`, `parallel` | `advanced` |
| `minimal` | `turbo` |

### How to write good Parallel searches

Parallel wants **both**:

1. **`objective`** — natural language goal (“compare Exa deep vs Parallel advanced for agent research”)
2. **`search_queries`** — 2–3 short keyword queries (3–6 words each)

If you only pass `query`, the tool uses it as both objective and a single search query.

### Extract

Use after search when a citation needs the page body:

- `urls: [...]`
- `excerpts: true` (default)
- `full_content: true` (opt-in, larger)
- optional `objective` / `search_queries` to focus excerpts
- `session_id` to correlate with a prior search

### Task / Deep Research processors

`operation: "task"` runs Parallel’s research processors ([pricing](https://docs.parallel.ai/getting-started/pricing)):

| Processor | Rough role | List price / run |
|---|---|---|
| `lite` | Narrow, cheap | $0.005 |
| `base` *(default)* | Standard research | $0.01 |
| `core` | Stronger multi-hop | $0.025 |
| `pro` | Hard questions | $0.10 |
| `ultra` | Deep | $0.30 |
| `ultra2x` / `ultra4x` / `ultra8x` | Max depth / breadth | up to $2.40 |

The tool creates a run and **polls until completion** (default 180s, override with `poll_timeout_ms`).

Optional `output_schema`:

- plain string → text schema description
- JSON schema object → structured JSON output
- `{ "type": "auto" }` → let Parallel decide

### What Parallel is *not*

- Not the best pure semantic “find pages like this embedding” store (Exa neural/deep shines there)
- Not X-native (use `x_search`)
- omp native Parallel path only ever sends beta **`fast`** with a single query — this tool is the full surface

---

## Choosing quickly

| Need | Call |
|---|---|
| Quick fact, any provider | `web_search` |
| Semantic / “find pages that mean X” | `exa_search` `type=neural` or `auto` |
| Hard multi-angle retrieval, still SERP-shaped | `exa_search` `type=deep` |
| Papers / people / companies vertical | `exa_search` + `category` |
| Short cited answer only | `exa_search` `operation=answer` |
| Long excerpts for LLM synthesis | `parallel_search` `mode=basic|advanced` |
| Cheapest Parallel skim | `parallel_search` `mode=turbo` |
| Read these URLs deeply | `parallel_search` `operation=extract` **or** `exa_search` `operation=contents` |
| Multi-step research report | `parallel_search` `operation=task` `processor=base|core|pro…` |
| User said “use both / expand” | `web_search` + `exa_search` + `parallel_search`, then merge |

---

## Side-by-side: native omp vs omp-search

| Capability | Native omp (current) | **omp-search** |
|---|---|---|
| Exa via `web_search` provider | Yes, but always `type=auto` + summary; no filters | Full types, categories, filters, contents, answer, contents fetch |
| Exa Researcher / Websets settings | UI toggles exist; **do not register tools** | Out of scope for v1 (Search/Answer/Contents first) |
| Parallel via `web_search` | Beta endpoint, hardcoded `mode=fast`, single query | V1 `turbo|basic|advanced`, multi-query, source policy |
| Parallel extract | Fetch/YouTube fallback only | Explicit `operation=extract` |
| Parallel Task / Deep Research | Not exposed | `operation=task` + all processors |
| Trigger phrase “use Exa/Parallel” | Relies on provider preference / failures | Dedicated tools the model can select by name |

---

## Env defaults

**Exa**

- `OMP_EXA_DEFAULT_TYPE` — `auto` \| `fast` \| `neural` \| `deep` (default `auto`)
- `OMP_EXA_DEFAULT_NUM_RESULTS` — default `10`
- `OMP_EXA_DEFAULT_CONTENTS` — `summary` \| `text` \| `highlights` \| `none` \| `all` (default `summary`)
- `EXA_API_KEY`

**Parallel**

- `OMP_PARALLEL_DEFAULT_MODE` — `turbo` \| `basic` \| `advanced` (default `advanced`)
- `OMP_PARALLEL_DEFAULT_PROCESSOR` — `lite`…`ultra8x` (default `base`)
- `OMP_PARALLEL_MAX_POLL_MS` — task poll budget (default `180000`)
- `PARALLEL_API_KEY`

---

## Suggested A/B test matrix

For a fixed question set (news, docs, entity, multi-hop):

1. `web_search` (native baseline)
2. `exa_search` type=`auto` / `neural` / `deep`
3. `parallel_search` mode=`turbo` / `basic` / `advanced`
4. `parallel_search` operation=`task` processor=`lite` / `base` / `core`

Score: citation precision, recall of must-find URLs, latency, $ cost, answer usefulness after one model synthesis pass.
