---
name: omp-search-confirm
description: "Before web/Exa/Parallel research, recommend tool mix + settings and wait for user approval"
alwaysApply: true
---

# Research settings gate (omp-search)

When the user asks for something that needs **live web research** — facts, news, comparisons, literature, company/people lookup, multi-source synthesis — **do not call** `web_search`, `exa_search`, or `parallel_search` immediately.

Instead, use **this session's main model** (you) to propose a plan first, then wait.

## 1. Restate the goal

One short sentence: what answer is needed and any constraints (recency, domains, depth, budget).

## 2. Recommend the tool mix

Pick **one** primary path, or an explicit combination. Prefer the cheapest path that can still answer well.

| Complexity | Prefer | Why |
|---|---|---|
| Quick fact / docs / obvious query | **`web_search` alone** | Fast, already configured; no Exa/Parallel spend |
| Semantic “pages like this meaning”, verticals (papers/people/companies/github), multi-angle SERP | **`exa_search`** | Neural/deep + categories beat generic SERP |
| Objective + multi-query with long LLM excerpts | **`parallel_search` search** | Long excerpts for synthesis |
| Known URLs need body text | **`exa_search` contents** or **`parallel_search` extract** | Dedicated fetch |
| Multi-hop research report / deep synthesis | **`parallel_search` task** | Processor tiers synthesize; costlier |
| User said “expand” / high stakes / uncertain | **`web_search` + `exa_search` and/or `parallel_search`** | Merge citations after |

Also note when **not** to use these tools (codebase-only, X/Twitter → `x_search`, pure reasoning).

## 3. Recommend concrete settings

For each tool you plan to call, list the resolved settings and a **one-clause reason** for every non-default.

### If using `web_search`
- note provider preference if known; otherwise “session default”

### If using `exa_search`
Recommend:
- `operation`: `search` | `answer` | `contents`
- `type`: `auto` (default) | `fast` | `neural` | `deep`
- `contents`: `summary` (default) | `highlights` | `text` | `all` | `none`
- `num_results` / filters / `category` when useful

Heuristics:
- single factual Q, short answer enough → `operation=answer`
- entity vertical known → set `category`
- hard multi-angle / easy to miss sources → `type=deep`
- speed/cheap skim → `type=fast`, `contents=none` or `summary`
- default research SERP → `type=auto`, `contents=summary`, ~10 results

### If using `parallel_search`
Recommend:
- `operation`: `search` | `extract` | `task`
- for search: `mode` (`turbo`|`basic`|`advanced`), `objective`, 2–3 short `search_queries`, `max_results`
- for extract: `urls`, `excerpts`/`full_content`
- for task: `processor` (`lite`→`ultra8x`), `output_schema` if structured output helps, `poll_timeout_ms` if long

Heuristics:
- cheap skim → `mode=turbo`
- everyday → `mode=basic` or `advanced` (default advanced)
- multi-hop report → `operation=task`, start `lite`/`base` unless user asked deep
- always prefer 2–3 keyword `search_queries` with a clear `objective`

### Cost / latency snapshot
Give a rough expected cost+latency band (order of magnitude is fine), e.g.:
- web_search: low / seconds
- exa auto+summary: ~$0.01 / few seconds; deep higher
- parallel turbo/basic/advanced: ~$0.001–0.005 / sub-second–few seconds
- parallel task lite/base/core: cents–tens of cents / tens of seconds+

## 4. Wait for approval

Stop after the plan. Do **not** call research tools until the user approves or adjusts
(“go”, “use deep”, “web only”, “skip parallel”, etc.).

When approved, call tools with the agreed settings (or the user’s tweaks). After results, synthesize; only then suggest a follow-up deeper pass if gaps remain.

## 5. Skip this gate when

- User explicitly says to run immediately / skip confirmation / “just search”
- User already specified exact tool+settings to run now
- The task needs no live web research
- A follow-up call in the **same** approved plan (e.g. extract URLs from a search the user just approved) — don’t re-prompt unless settings change materially

## Example shape (keep it tight)

```text
Goal: …
Recommended mix: web_search + exa_search (not parallel)
  • web_search — quick baseline
  • exa_search: type=deep, contents=summary, num_results=10, category=research paper
    reason: multi-angle academic sources
Rough cost/latency: …
Approve / tweak?
```
