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

Or copy the two files:

```bash
mkdir -p ~/.omp/agent/tools
cp exa_search.ts parallel_search.ts ~/.omp/agent/tools/
```

**Project-level:** copy both files into `<repo>/.omp/tools/`.

Restart open omp sessions so discovery reloads tools.

## Usage examples

```text
Use exa_search with type=deep for multi-angle sources on <topic>.
Use parallel_search mode=advanced with 3 keyword queries on <topic>.
Run web_search, then expand with exa_search and parallel_search and merge citations.
Extract these URLs with parallel_search operation=extract.
Research this with parallel_search operation=task processor=core.
Answer with citations via exa_search operation=answer.
```

### `exa_search` parameters (summary)

| Param | Notes |
|---|---|
| `query` | Required for search/answer |
| `operation` | `search` (default) \| `answer` \| `contents` |
| `type` | `auto` \| `fast` \| `neural` \| `deep` (+ aliases) |
| `contents` | `summary` \| `text` \| `highlights` \| `none` \| `all` |
| `category` | company, people, research paper, news, pdf, github, … |
| `num_results` / `limit` | 1–100 |
| domain/date/text filters | optional |
| `urls` | for `operation=contents` |

### `parallel_search` parameters (summary)

| Param | Notes |
|---|---|
| `query` / `objective` | Natural-language goal |
| `search_queries` | 2–3 short keyword queries preferred |
| `operation` | `search` (default) \| `extract` \| `task` |
| `mode` | `turbo` \| `basic` \| `advanced` (+ aliases) |
| `max_results` / `limit` | up to 40 |
| `include_domains` / `exclude_domains` / `location` | optional |
| `urls` | for extract |
| `processor` | task tier: `lite`…`ultra8x` |
| `output_schema` | task structured output |
| `poll_timeout_ms` | task wait budget |

Full mode semantics, costs, and decision tables: **[docs/MODES.md](./docs/MODES.md)**.

## Configuration

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
