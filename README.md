# omp-search

> Full-power **Exa** and **Parallel** search tools for the [omp](https://omp.sh) coding agent — drop-in custom tools, no rebuild.

`omp-search` adds two first-class tools next to omp’s built-in `web_search` and the companion [`omp-x-search`](https://github.com/bnivanov/omp-x-search) tool:

| Tool | Label | Purpose |
|---|---|---|
| `exa_search` | **Exa Search** | Full Exa Search + Answer + Contents with explicit types (`auto` / `fast` / `neural` / `deep`), categories, filters |
| `parallel_search` | **Parallel Search** | Full Parallel V1 Search modes (`turbo` / `basic` / `advanced`), Extract, and Task/Deep Research processors |

Natural language is enough:

- *“use exa for search: …”*
- *“use parallel for search: …”*
- *“use your normal web search and expand with Exa and Parallel”*

## Why this exists

Native omp already knows Exa and Parallel as **`web_search` providers**, but the built-in path is intentionally thin:

| | Native omp `web_search` | **omp-search** |
|---|---|---|
| Provider selection | Auto-chain or `providers.webSearch` preference (often Brave first) | Dedicated tools — model picks Exa/Parallel by name |
| Exa `type` | Always **`auto`** + summary | **`auto` / `fast` / `neural` / `deep`** (+ keyword/instant aliases) |
| Exa filters / categories | Not exposed | Domains, dates, categories, include/exclude text, additional queries |
| Exa Answer / Contents APIs | Not exposed | `operation=answer` and `operation=contents` |
| Exa Researcher / Websets settings | `exa.enableResearcher` / `exa.enableWebsets` exist in config UI but **do not register tools** today | Documented; Search/Answer/Contents shipped first |
| Parallel endpoint | **Beta** `/v1beta/search` | **V1** `/v1/search` |
| Parallel mode | Hardcoded beta **`fast`** | **`turbo` / `basic` / `advanced`** (+ aliases) |
| Parallel multi-query | Single `search_queries: [query]` | Objective + multiple keyword queries |
| Parallel Extract | Only as fetch/YouTube fallback | Explicit `operation=extract` |
| Parallel Task / Deep Research | Not exposed | `operation=task` with `lite`…`ultra8x` |
| Trigger UX | Indirect (provider failovers / settings) | Same pattern as `x_search` — tool description steers the model |

This package focuses on **Exa + Parallel only**. It does not replace Brave/Kagi/etc., and it does not reimplement X search ([omp-x-search](https://github.com/bnivanov/omp-x-search) does that).

## Requirements

- **omp** with custom tools enabled (default)
- Credentials (session `/login` or env):
  - **Exa:** `EXA_API_KEY` or omp Exa login
  - **Parallel:** `PARALLEL_API_KEY` or omp Parallel login

## Install

**User-level** (every project):

```bash
git clone https://github.com/bnivanov/omp-search
cd omp-search && ./install.sh
```

**With the opt-in research gate** (recommended — same pattern as [omp-x-search](https://github.com/bnivanov/omp-x-search)):

```bash
./install.sh --with-gate
```

| Flag | What it installs |
|---|---|
| *(default)* | `exa_search.ts` + `parallel_search.ts` only |
| `--with-confirm-rule` | + recommend-first agent rule |
| `--with-approval-gate` | + `tools.approval.*.allow` in `config.yml` |
| `--with-gate` | both (rule + explicit allow policy) |

Or copy the two files:

```bash
mkdir -p ~/.omp/agent/tools
cp exa_search.ts parallel_search.ts ~/.omp/agent/tools/
```

**Project-level:** copy both files into `<repo>/.omp/tools/`.

Restart open omp sessions so discovery reloads tools (and rules, if installed).

## Usage examples

```text
Use exa_search with type=deep for multi-angle sources on <topic>.
Use parallel_search mode=advanced with 3 keyword queries on <topic>.
Run web_search, then expand with exa_search and parallel_search and merge citations.
Extract these URLs with parallel_search operation=extract.
Research this with parallel_search operation=task processor=core.
Answer with citations via exa_search operation=answer.
```

Mode semantics, costs, and pick-this-vs-that tables: **[docs/MODES.md](./docs/MODES.md)**.

## Confirm settings before research (opt-in, recommended)

Which tools you call — and which Exa `type` / Parallel `mode` / task `processor` — materially change **cost, latency, and answer shape**. Like [omp-x-search](https://github.com/bnivanov/omp-x-search#confirm-settings-before-each-search-recommended), you can make the **main driver model** (Claude/GPT/Gemini/Grok — whatever is running the session) **recommend a plan and wait for your OK** before any research tool fires.

Two layers; use either or both.

### 1. Approval policy — `allow` by default

The installer writes an explicit per-tool policy to `~/.omp/agent/config.yml` (honored in every mode, including `yolo`):

```yaml
tools:
  approval:
    exa_search: allow       # allow | prompt | deny
    parallel_search: allow
```

- **`allow`** — what the installer writes. The tool runs without a modal; the recommend-first rule (below) is your control point.
- **`prompt`** — require a one-click approval that shows the resolved plan. Both tools ship `formatApprovalDetails`:

```text
Allow tool: exa_search
Operation: search (default)
Query: compare Exa deep vs Parallel advanced for agent research
Type: deep  |  Results: 10  |  Contents: summary (default)
Category: research paper
```

```text
Allow tool: parallel_search
Operation: search (default)
Objective: compare Exa deep vs Parallel advanced for agent research
Mode: advanced (default)  |  Results: 10 (default)
Search queries: ["exa deep search","parallel ai advanced mode"]
```

- **`deny`** — block the tool entirely.

Let the installer set `allow`: `./install.sh --with-approval-gate` (or `--with-gate`). Prefer a hard gate? Set the policy to `prompt`, then approve to run — reject and tell the agent what to change (`type=auto`, `mode=turbo`, `web only`, …).

### 2. Recommend-first behavior — the conversational step

Drop the rule (or `./install.sh --with-confirm-rule` / `--with-gate`):

```bash
mkdir -p ~/.omp/agent/rules
cp rules/omp-search-confirm.md ~/.omp/agent/rules/
```

The rule tells the **session’s main model** to, on any live-web research request:

1. **Restate the goal**
2. **Recommend the tool mix** — `web_search` alone vs `exa_search` vs `parallel_search` vs a combination — based on complexity
3. **Recommend concrete settings** (Exa `type`/`contents`/`category`, Parallel `mode`/`search_queries`/`processor`, …) with a one-clause reason for each non-default
4. **Give a rough cost/latency band**
5. **Wait for approval or tweaks** before calling tools

Example shape:

```text
Goal: multi-hop comparison of agent memory backends with primary sources
Recommended mix: web_search + exa_search + parallel_search
  • web_search — cheap baseline
  • exa_search: type=deep, contents=summary, num_results=10
    reason: multi-angle SERP, easy to miss vendors
  • parallel_search: mode=advanced, 3 keyword queries, max_results=10
    reason: long excerpts for synthesis
  (skip task/ultra unless gaps remain)
Rough cost/latency: web free-tier + ~$0.02–0.05 Exa/Parallel search; seconds–tens of seconds
Approve / tweak?
```

Layer 1 is the config policy — `allow` by default (no modal); set `prompt` for a hard gate or `deny` to block.  
Layer 2 is the conversational UX (you react to a recommendation instead of a bare yes/no).

Skip the gate when you say “just search” / already specify exact settings / no live web is needed / follow-up extract under an already-approved plan.


## Settings reference

Every tool argument and env default is documented below. Values in **bold** are defaults.

### `exa_search` — shared / routing

| Setting | Type | Default | What it does |
|---|---|---|---|
| **`query`** | string | *(required for search/answer)* | Natural-language objective or question. Prefer “describe the ideal page” over bare keywords. |
| **`operation`** | enum | **`search`** | Which Exa API to call. |
| | | `search` | `POST /search` — ranked results (+ optional contents). |
| | | `answer` | `POST /answer` — short grounded answer + citations. Cheaper for one factual Q. |
| | | `contents` | `POST /contents` — fetch/parse known URLs (needs `urls`). |

### `exa_search` — search type (`operation=search`)

| Setting | Type | Default | What it does |
|---|---|---|---|
| **`type`** | enum | **`auto`** (or `OMP_EXA_DEFAULT_TYPE`) | Retrieval strategy. |
| | | `auto` | Exa picks the path. Best everyday default. ~$0.007 + contents. |
| | | `fast` | Faster / cheaper keyword-ish path. |
| | | `neural` | Pure semantic similarity (“pages that mean X”). |
| | | `deep` | Multi-angle expansion; slower (~4–12s+), higher cost (~$0.012+). Hard research. |
| | | `keyword`, `instant` | **Aliases → `fast`**. |
| **`num_results`** | int 1–100 | **`10`** (or `OMP_EXA_DEFAULT_NUM_RESULTS`) | How many hits to return. |
| **`limit`** | int 1–100 | — | Alias of `num_results`. |

### `exa_search` — contents packing (`operation=search`)

Controls how much page body you pay for and receive per result.

| Setting | Type | Default | What it does |
|---|---|---|---|
| **`contents`** | enum | **`summary`** (or `OMP_EXA_DEFAULT_CONTENTS`) | Content packing mode. |
| | | `summary` | Per-result summary focused on the query. Best default for agents. |
| | | `highlights` | Query-relevant snippet sentences. |
| | | `text` | Longer extracted page text. |
| | | `all` | summary + highlights + text (richest, costliest). |
| | | `none` | Links/metadata only (cheapest). |
| **`summary_query`** | string | = `query` | Override the focus query used for summaries. |
| **`highlights_query`** | string | — | Focus query for highlights (also forces highlights on). |
| **`highlights_per_url`** | int 1–10 | 3 if set path used | How many highlight chunks per URL. |
| **`highlights_num_sentences`** | int 1–20 | 3 if set path used | Sentences per highlight chunk. |
| **`text_max_characters`** | int 100–50000 | 2000 if set path used | Cap extracted text length (also forces text on). |

### `exa_search` — verticals & filters (`operation=search`)

| Setting | Type | Default | What it does |
|---|---|---|---|
| **`category`** | enum | — | Restrict to an Exa vertical index: `company`, `people`, `research paper`, `news`, `pdf`, `github`, `personal site`, `financial report`, `tweet`. Use when you know the entity type. |
| **`include_domains`** | string[] | — | Only these domains (e.g. `["arxiv.org","openai.com"]`). |
| **`exclude_domains`** | string[] | — | Drop these domains. |
| **`start_published_date`** | ISO string | — | Lower bound on page published date. |
| **`end_published_date`** | ISO string | — | Upper bound on page published date. |
| **`start_crawl_date`** | ISO string | — | Lower bound on when Exa crawled the page. |
| **`end_crawl_date`** | ISO string | — | Upper bound on crawl date. |
| **`include_text`** | string[] (≤5) | — | Require these phrases somewhere on the page. |
| **`exclude_text`** | string[] (≤5) | — | Exclude pages containing these phrases. |
| **`additional_queries`** | string[] (≤5) | — | Extra query angles. Pairs especially well with `type=deep`. |
| **`user_location`** | string | — | ISO country bias, e.g. `US`, `DE`. |
| **`moderation`** | bool | — | When `true`, enable Exa moderation filtering. |
| **`livecrawl`** | string | — | Livecrawl preference when supported (e.g. `fallback`, `preferred`). |
| **`max_age_hours`** | int ≥0 | — | Prefer fresher pages when supported. |

### `exa_search` — answer (`operation=answer`)

| Setting | Type | Default | What it does |
|---|---|---|---|
| **`query`** | string | required | The question to answer. |
| **`text`** | bool | **`false`** | When `true`, include source text alongside citations. |

Observed cost: ~$0.005 per answer on a typical short question.

### `exa_search` — contents fetch (`operation=contents`)

| Setting | Type | Default | What it does |
|---|---|---|---|
| **`urls`** | string[] (≤20) | **required** | URLs to fetch/parse through Exa. |
| **`query`** | string | optional | If set, used as the summary focus for each URL. |

Always requests text + highlights; summary only when `query` is set.

### `exa_search` — environment defaults

| Env | Default | Effect |
|---|---|---|
| `EXA_API_KEY` | — | Auth fallback after omp session `/login` Exa key. |
| `OMP_EXA_DEFAULT_TYPE` | `auto` | Default `type` when the model omits it. |
| `OMP_EXA_DEFAULT_NUM_RESULTS` | `10` | Default result count. |
| `OMP_EXA_DEFAULT_CONTENTS` | `summary` | Default contents packing. |

---

### `parallel_search` — shared / routing

| Setting | Type | Default | What it does |
|---|---|---|---|
| **`query`** | string | usually required | Primary natural-language objective. Used as both objective and a keyword query when others are omitted. |
| **`objective`** | string | = `query` | Natural-language goal (“compare X vs Y for agent research”). Preferred over bare keywords. |
| **`operation`** | enum | **`search`** | Which Parallel API to call. |
| | | `search` | `POST /v1/search` — objective + keyword queries → ranked URLs with long excerpts. |
| | | `extract` | `POST /v1/extract` — excerpts/full content for known URLs (needs `urls`). |
| | | `task` | `POST /v1/tasks/runs` + poll — Deep Research processor that synthesizes an answer. |

### `parallel_search` — search mode (`operation=search`)

| Setting | Type | Default | What it does |
|---|---|---|---|
| **`mode`** | enum | **`advanced`** (or `OMP_PARALLEL_DEFAULT_MODE`) | V1 Search quality tier. |
| | | `turbo` | Fastest/cheapest (~$0.001 / 10 results). High-volume skim. |
| | | `basic` | Balanced everyday agent search (~$0.005). |
| | | `advanced` | Highest quality retrieval + compression (~$0.005 list). Best default. |
| | | `fast`, `one-shot`, `one-shot-new` | **Aliases → `basic`**. |
| | | `agentic`, `research`, `comprehensive`, `parallel` | **Aliases → `advanced`**. |
| | | `minimal` | **Alias → `turbo`**. |
| **`search_queries`** | string[] (≤10) | auto from `query` | Short **keyword** queries (3–6 words each). Prefer **2–3**. Parallel quality depends on these more than on a long objective alone. |
| **`max_results`** | int 1–40 | **10** | Cap on returned results. |
| **`limit`**, **`num_results`** | int 1–40 | — | Aliases of `max_results`. |
| **`max_chars_per_result`** | int 200–50000 | API default | Max excerpt characters per result. |
| **`max_chars_total`** | int 500–500000 | — | Cap total characters across the whole response. |
| **`include_domains`** | string[] | — | Source policy: only these domains. |
| **`exclude_domains`** | string[] | — | Source policy: drop these domains. |
| **`location`** | string | — | ISO 3166-1 alpha-2 country code (e.g. `us`). |
| **`live_fetch`** | bool | — | When `true`, force live fetch (`max_age_seconds=0`) — fresher, higher latency. |
| **`max_age_seconds`** | int ≥0 | — | Accept cached pages up to this age. Ignored if `live_fetch=true`. |
| **`session_id`** | string | — | Correlate this search with a later `extract` in the same workflow. |
| **`client_model`** | string | — | Optional client model label sent to Parallel for telemetry. |

**How to write a good Parallel search**

1. Set **`objective`** to the natural-language goal.
2. Pass **2–3 short `search_queries`** (keyword style).
3. If you only pass `query`, the tool uses it as both objective and the sole search query.

### `parallel_search` — extract (`operation=extract`)

| Setting | Type | Default | What it does |
|---|---|---|---|
| **`urls`** | string[] (≤20) | **required** | URLs to extract. |
| **`excerpts`** | bool | **`true`** | Include focused excerpts. |
| **`full_content`** | bool | **`false`** | Include full page content (larger/slower). |
| **`objective`** / **`query`** | string | — | Focus what the excerpts should capture. |
| **`search_queries`** | string[] | — | Extra keyword focus for extraction. |
| **`max_chars_total`** | int | — | Cap total returned characters. |
| **`session_id`** | string | — | Tie extract back to a prior search. |
| **`client_model`** | string | — | Optional telemetry label. |

### `parallel_search` — task / deep research (`operation=task`)

Creates a Parallel Task run and **polls until completion** (or timeout).

| Setting | Type | Default | What it does |
|---|---|---|---|
| **`processor`** | enum | **`base`** (or `OMP_PARALLEL_DEFAULT_PROCESSOR`) | Research depth/cost tier. |
| | | `lite` | Narrow, cheapest (~$0.005 / run). |
| | | `base` | Standard research (~$0.01). |
| | | `core` | Stronger multi-hop (~$0.025). |
| | | `pro` | Hard questions (~$0.10). |
| | | `ultra` | Deep (~$0.30). |
| | | `ultra2x` / `ultra4x` / `ultra8x` | Max depth/breadth (up to ~$2.40). |
| **`query`** / **`objective`** / **`task_input`** | string or object | one required | Task input. `task_input` wins if set; else objective/query text. |
| **`output_schema`** | string \| object | — | Shape of the answer. |
| | | plain string | Treated as a **text** schema description. |
| | | `{ "type": "auto" }` | Let Parallel choose the schema. |
| | | `{ "type": "text", "description": "…" }` | Explicit text schema. |
| | | `{ "type": "json", "json_schema": {…} }` | Explicit JSON schema wrapper. |
| | | bare JSON Schema object | Wrapped as `{ type: "json", json_schema: … }`. |
| **`previous_interaction_id`** | string | — | Continue from a prior Parallel interaction. |
| **`include_domains`** / **`exclude_domains`** | string[] | — | Source policy applied to the task run. |
| **`poll_timeout_ms`** | int 5000–900000 | **`180000`** (or `OMP_PARALLEL_MAX_POLL_MS`) | Max wait for the run to finish before erroring. |

List prices from [Parallel pricing](https://docs.parallel.ai/getting-started/pricing); your plan may differ.

### `parallel_search` — environment defaults

| Env | Default | Effect |
|---|---|---|
| `PARALLEL_API_KEY` | — | Auth fallback after omp session `/login` Parallel key. |
| `OMP_PARALLEL_DEFAULT_MODE` | `advanced` | Default search `mode` when omitted. |
| `OMP_PARALLEL_DEFAULT_PROCESSOR` | `base` | Default task `processor` when omitted. |
| `OMP_PARALLEL_MAX_POLL_MS` | `180000` | Default task poll budget (ms). |

---

## Configuration cheat sheet

| Env | Default | Meaning |
|---|---|---|
| `EXA_API_KEY` | — | Exa auth fallback |
| `PARALLEL_API_KEY` | — | Parallel auth fallback |
| `OMP_EXA_DEFAULT_TYPE` | `auto` | Default Exa search type |
| `OMP_EXA_DEFAULT_NUM_RESULTS` | `10` | Default Exa result count |
| `OMP_EXA_DEFAULT_CONTENTS` | `summary` | Default Exa contents packing |
| `OMP_PARALLEL_DEFAULT_MODE` | `advanced` | Default Parallel search mode |
| `OMP_PARALLEL_DEFAULT_PROCESSOR` | `base` | Default task processor |
| `OMP_PARALLEL_MAX_POLL_MS` | `180000` | Task poll budget |

Auth order for both tools: **omp session key** (`ctx.modelRegistry.authStorage`) → **env var**.

## How it works

- Each file is a single omp **custom tool factory** (`export default (host) => tool`), same discovery path as `~/.omp/agent/tools/x_search.ts`.
- Tools resolve API keys from the live omp session (`ctx.modelRegistry.authStorage`) first, then env vars.
- No npm install, no build step, survives omp upgrades.
- Results are markdown for the driver model plus structured `details.response` for UIs/tests.

## Scope of this repo (v1)

**In scope**

- Exa Search / Answer / Contents with full practical parameter surface
- Parallel V1 Search / Extract / Task (deep research processors)
- Modes documentation and native-vs-extension comparison
- Install script matching `omp-x-search`

**Out of scope (for now)**

- Exa Websets CRUD MCP and long-running Exa Researcher agent APIs (native toggles are still inert; can be a v2)
- Parallel FindAll / Monitor / Chat product surfaces
- Replacing omp’s auto `web_search` chain

## License

[MIT](./LICENSE)
