# omp-extended-search

Extra search tools for the [omp](https://omp.sh) coding agent. omp's built-in `web_search` covers everyday lookups; these tools add backends or advanced controls it exposes poorly or not at all. Each tool is one self-contained TypeScript file — no build step, no dependencies, survives omp upgrades.

Install only the ones you want.

| Tool | File | What it does | Credentials |
|---|---|---|---|
| Hacker News | `tools/hackernews_search.ts` | Full-text search over HN stories and comments (Algolia), plus the current top/new/best/ask/show/job feeds (official API). | none |
| Feeds | `tools/feed_search.ts` | RSS/Atom reader for news, blogs, and newsletters (Substack, Medium, lab blogs). Preset bundles for AI labs and tech news, or any feed URL. | none |
| arXiv | `tools/arxiv_search.ts` | Searches arXiv papers by text, category (cs.AI, cs.LG, cs.CL, …), author, and date. | none |
| Reddit | `tools/reddit_search.ts` | Search posts in named subreddits (default tech/AI bundle) via Arctic Shift, a third-party Reddit archive. No Reddit app approval. | none |
| GitHub | `tools/github_search.ts` | Repository search by keyword, creation window, stars, language, topic — the proxy for "trending" (which has no API). | none needed; `GITHUB_TOKEN` or `gh auth` raises the rate limit |
| Product Hunt | `tools/producthunt_search.ts` | Recent/top launches by topic and date (the v2 API has no keyword search — it lists, it doesn't grep). | `PRODUCTHUNT_API_TOKEN` (Developer Token from the free app page — not the API Key) |
| X Search | `tools/x_search.ts` | Searches public posts on X (Twitter) via xAI's native search. Keyword, semantic, user, and thread search; can optionally resolve each cited post to its real text and engagement numbers. | `/login` → xAI Grok (SuperGrok or X Premium+), or `XAI_API_KEY` |
| X API | `tools/x_api.ts` | Read-only X API v2: recent/archive search, lookup, threads, user, timeline, counts. Exact operators and `public_metrics`. | `X_BEARER_TOKEN` or `TWITTER_BEARER_TOKEN` (not `XAI_API_KEY`) |
| Exa Search | `tools/exa_search.ts` | Full Exa API: search types (`auto` / `fast` / `neural` / `deep`), vertical categories (papers, people, companies, github), domain/date filters, answer-with-citations, URL contents fetch. omp's native Exa path only ever uses `auto` + summary. | `/login` → Exa, or `EXA_API_KEY` |
| Firecrawl Search | `tools/firecrawl_search.ts` | Direct Firecrawl Search v2 plus Research/Developer indexes: web/news/images sources, GitHub/research/PDF categories, papers/paper/related/developer operations, domain/date/location filters, highlights, optional page scraping. omp 17.0.9+ can use Firecrawl behind ordinary `web_search` when Firecrawl is explicitly selected in `providers.webSearchOrder`; this extension is the advanced/direct lane. | Credential order: omp session/provider Firecrawl credential first; `FIRECRAWL_API_KEY` second; keyless access last (limited). Either credential provides higher limits. |
| Firecrawl Crawl | `tools/firecrawl_crawl.ts` | Site traversal and extraction: `map`, `scrape` (incl. JSON mode), `crawl`, `batch`, `extract`, `agent`, `interact`, plus status/cancel. The only crawl/extract primitive in the fleet. Reaches **public pages only**: Firecrawl sends no cookies or session, so anything behind a login needs the `xd://browser` device. Bills per scraped page; agent bills dynamically (`max_credits`). | Same credential order as Firecrawl Search |
| Parallel Search | `tools/parallel_search.ts` | Full Parallel V1 API: search modes (`turbo` / `basic` / `advanced`) with objective + multi-query support, URL extract, and deep-research task processors (`lite` … `ultra8x`). omp's native path hardcodes the old beta `fast` mode. | `/login` → Parallel, or `PARALLEL_API_KEY` |
| Tavily Search | `tools/tavily_search.ts` | Full Tavily AI search with basic/advanced depth, news/finance topic filters, synthesized answers, URL batch extract, sitemap mapping, crawl, and live quota queries. | `/login` → Tavily, or `TAVILY_API_KEY` |

Research routing lives in the **deep-research skill** ([.agents/skills/deep-research/SKILL.md](.agents/skills/deep-research/SKILL.md)) plus [docs/capability-catalog.md](docs/capability-catalog.md). The model constructs a plan from the capability table (chosen vs rejected, cost **estimate**, numbered how-to-proceed options), writes it as a **visible chat message**, and waits. Thinking does not count. Do not use the `ask` tool. Not an alwaysApply rule.

## Install

```bash
git clone https://github.com/bnivanov/omp-extended-search
cd omp-extended-search

./install.sh install hackernews feed arxiv   # the free, no-key tools
./install.sh install exa parallel            # just Exa and Parallel
./install.sh install firecrawl-crawl         # site map / scrape / crawl
./install.sh install all                     # everything
./install.sh hackernews feed                 # legacy form — same as install
./install.sh                                 # prints help, installs nothing
```

### Keeping tools current

Tool files are **copied**, not symlinked, so a `git pull` does not update what omp actually loads.
`update` exists for that, and it never installs anything you did not choose:

```bash
./install.sh list            # every repo tool: not installed / installed (up to date) / installed (outdated)
./install.sh update          # refresh ONLY the tools already in ~/.omp/agent/tools
./install.sh update exa      # refresh one, errors if you never installed it
./install.sh update --all    # refresh installed tools AND add every repo tool that is missing
./install.sh uninstall arxiv # remove one
```

`list` compares file contents, not timestamps, so `outdated` means the bytes actually differ. Every copy
reports `Installed` / `Added` / `Updated` / `Unchanged` per file.

Use plain `update` after a `git pull` to refresh your selection. Use `update --all` when you also want
tools added to the repo since you installed — otherwise a newly added tool is silently never discovered.

Or grab a single tool without cloning the repo:

```bash
mkdir -p ~/.omp/agent/tools
curl -fsSL https://raw.githubusercontent.com/bnivanov/omp-extended-search/main/tools/x_search.ts \
  -o ~/.omp/agent/tools/x_search.ts
```

For a project-level install, copy the file into `<your-project>/.omp/tools/` instead. Either way, restart any open omp session afterwards so the new tools are discovered.

## Usage

### In chat (humans)

Just ask — the model should pick the tool from your wording:

- "What's on the front page of Hacker News right now?"
- "Check the ai-labs feeds for anything about agents this week"
- "Find recent arxiv papers on agent memory"
- "Search reddit for omp reviews"
- "Find new github repos about MCP servers"
- "What launched on Product Hunt this week?"
- "What's being said on X about the latest omp release?"
- "Use exa for search: recent papers on agent memory"
- "Use Firecrawl news search for this week and return highlights"
- "Use parallel for search: compare agent memory backends"
- "Use tavily for search: latest breakthroughs in AI agents"
- "Use your normal web search and expand with Exa, Parallel, and Tavily"

### How the agent must invoke them (omp xdev)

These install as **discoverable** custom tools. In current omp they mount on the
**`xd://` virtual device bus** — they are **not** top-level function-call tools
like built-in `web_search`, and there is **no `xdi://` scheme**.

Canonical agent flow after install + session restart:

1. **Discover / schema:** `read` `xd://hackernews_search` (or whichever tool).
2. **Execute:** `write` a JSON args object to the same path, e.g.
   `xd://hackernews_search` with body `{"query":"omp","operation":"search","limit":10}`.
3. The write result **is** the tool output. Do not expect a separate side channel.

```text
# schema
read  xd://hackernews_search

# run
write xd://hackernews_search
{"operation":"feed","feed":"top","count":10}

# other tools — same pattern
write xd://reddit_search
{"query":"omp","subreddits":["LocalLLaMA"],"sort":"top","time":"week","limit":10}

write xd://x_search
{"query":"omp agent","focus":"relevance","recency":"week","limit":10}

write xd://x_api
{"operation":"recent","query":"from:xai lang:en -is:retweet","max_results":10}

write xd://firecrawl_search
{"query":"agent memory","sources":["news"],"recency":"week","limit":5}
```

**Common failure mode:** writing to `xdi://…` or a bare filename creates a
normal file/directory in the workspace and **never runs the tool**. Always use
the exact prefix **`xd://`** plus the tool name (`hackernews_search`,
`firecrawl_search`, `x_search`, …).

Built-in `web_search` may still appear as a native tool *or* as `xd://web_search`
depending on omp version — prefer whatever the session already exposes; do not
invent a third URI. Since omp 17.0.9, that built-in lane can use Firecrawl,
including limited keyless access, **only when Firecrawl is explicitly selected
in `providers.webSearchOrder`**. The automatic provider chain remains
credential-gated, and this installer does not set provider order. Keep built-in
`web_search` as the everyday default; invoke `xd://firecrawl_search` only when
you need Firecrawl-specific sources, categories, filters, scrape controls, or
raw Firecrawl metadata.

## How it works with omp

1. **Install** the tool files into `~/.omp/agent/tools/` (or a project `.omp/tools/`).
2. **Restart omp** — it picks up new tool files and mounts them under `xd://<name>`.
   Sanity check: `read xd://hackernews_search` (or another installed tool) returns a schema.
3. **Built-in `web_search` stays the default** for everyday lookups. omp 17.0.9+ can back it with Firecrawl when explicitly configured in `providers.webSearchOrder`; this installer leaves that order unchanged. These tools add lanes or controls omp covers poorly or not at all (X, HN, Reddit, PH, arXiv, feeds, advanced/direct Firecrawl, full Exa/Parallel, GitHub discovery). You can mix them: “use normal web search and also check HN + Reddit.”
4. **Optional plan-first skill** — with the deep-research skill installed, the agent does **not** fire searches immediately. It writes a **visible** capability plan (Chosen vs Rejected vs cost estimate vs numbered how-to-proceed options) in the chat message and waits. Thinking does not count. Do not use the `ask` tool. After you reply with a number or a tweak, it invokes via `write` to `xd://…` as above.

## Optional: deep-research skill (plan in chat)

Settings change cost, latency, and which corner of the internet you hit. If you'd rather shape the research in chat first:

```bash
./install.sh all --with-confirm-rule
# shorthand that also writes tools.approval.<tool>: allow (harmless under yolo):
./install.sh all --with-gate
```

That copies [`.agents/skills/deep-research/`](.agents/skills/deep-research/) to `~/.omp/agent/skills/deep-research/` and **removes** any leftover alwaysApply confirm rule (`omp-search-confirm.md`). The gate is §0 of the skill.

The catalog the model plans from is [docs/capability-catalog.md](docs/capability-catalog.md) (also `skill://deep-research/references/capability-catalog.md`). It is a capability table, **not** a first-use-this ladder. Every plan must name why it picked the mix **and** why it rejected the near-misses, plus a cost/limit **estimate** (guidance, not a quote — there is no per-call spend guard), then numbered options so you can QA the approach.

**Intended UX:** visible plan in chat (including options) → STOP → you reply `1` / `2` / a tweak → tools run. Keep `tools.approvalMode: yolo` (or per-tool `allow`) so tools run quietly after you pick. Only set a tool to `prompt` if you *want* a hard UI dialog every call. Say “just search” anytime to skip the chat gate for one request. “Research X” is **not** a skip.

## Known limitations

These come from a source-verified audit of the fleet ([docs/capability-matrix.md](docs/capability-matrix.md)),
re-checked adversarially. Claims here are about what the code does, not what the upstream APIs advertise.

### Resolved

- **No retry or backoff.** Nine of ten tools issued a single request and threw. Every tool now retries
  transient failures (408/425/429/502/503/504 plus pre-response transport errors) with bounded
  exponential jitter, honoring an explicit `Retry-After` against the call's remaining deadline.
- **Retries could double-charge.** Job creation (`parallel_search` task runs, `firecrawl_crawl` crawls)
  is never retried — a lost response there would start a second billed job. For billed POSTs, `500` is
  deliberately *not* retryable: the server accepted the work and may already have billed it.
- **No pagination.** arXiv, GitHub, and Hacker News hardcoded the first page; Reddit hardcoded 25
  results; Product Hunt requested no cursor. All five now paginate, and every tool reports a normalized
  `details.pagination` block with `continuation_supported`, so an agent can tell "there is more, here is
  how to get it" from "that is everything this tool can return".
- **arXiv ignored the ~1 req/3 s policy.** There is now a process-wide gate that spaces every request,
  including retries, with bounded admission.
- **Product Hunt was dead without an env var.** It now resolves an omp session credential first,
  matching the other tools.
- **`gh auth token` could hang forever.** Bounded, with the caller's signal threaded through.
- **No crawl primitive.** `firecrawl_crawl` adds `map` / `scrape` / `crawl` / `batch` / `extract` / `agent` / `interact`.
- **No way to refresh installed tools.** `install.sh update` / `list` / `uninstall` (see Install).

### Open

| Limitation | Detail |
|---|---|
| No authenticated crawling | Firecrawl sends no cookies or session. Anything behind a login needs the `xd://browser` device, driven per-investigation. No tool here can reach it. Worked example: [examples/authenticated-ux-crawl](examples/authenticated-ux-crawl) — 22 screens of a logged-in app, reviewed by parallel agents. |
| Parallel task runs cannot be cancelled | Verified against the live API: `DELETE /v1/tasks/runs/{id}` → 405, and `POST …/cancel` returns the generic router 404, not Parallel's structured error body. There is no cancel endpoint. A timed-out run keeps executing and billing; the tool now surfaces `details.orphanedRun` with the run id and an `operation: "task_status"` to retrieve it later. |
| No per-call spend guard | Exa `deep`, Parallel processors, `firecrawl_crawl`, and `x_api` can each run up cost. `x_api` reports `details.response.cost.guidance_usd` after the fact; nothing refuses a call for being too expensive. The plan-first gate is the current control. |
| Exa / Parallel / xAI `x_search` / Firecrawl search cannot paginate | Those APIs expose no page or cursor on these endpoints. `x_api` **does** paginate via `next_token` (opt-in; never auto-walked). |
| GitHub search caps at 1000 results | An upstream ceiling, not ours. The tool now rejects a page beyond it instead of returning a 422. |
| No geospatial search | Exa, Firecrawl, and Parallel accept a free-form location string as a ranking bias only — no coordinates, radius, or place details. |
| No Stack Exchange / Discourse adapter | `feed_search` reads their public RSS best-effort; there is no API adapter and no thread/comment corpus search. |
| No media search or transcription | No YouTube or podcast search, no download, no transcription. `feed_search` now parses `<enclosure>` so audio/video items keep their media URL, but nothing fetches them. |
| No cross-registry package discovery | `read https://registry.npmjs.org/<pkg>` and the PyPI JSON API already work for a known package; there is no discovery or dependency-graph normalization across registries. |
| Nothing persists between calls | Every tool is fetch-and-return. No result store, no snapshot diffing, no monitoring. Fan-out, merge, and follow-the-citation are composed per-investigation in the harness rather than built in. |

## Docs

- [docs/hackernews.md](docs/hackernews.md) — HN search + feed parameters
- [docs/feed.md](docs/feed.md) — feed bundles, filters, and how to build Substack/Medium/Google News feed URLs
- [docs/arxiv.md](docs/arxiv.md) — arXiv search parameters
- [docs/reddit.md](docs/reddit.md) — Arctic Shift archive (no Reddit app) and search parameters
- [docs/github.md](docs/github.md) — repo search qualifiers
- [docs/producthunt.md](docs/producthunt.md) — token setup and parameters
- [docs/x.md](docs/x.md) — x_search settings: focus, reasoning effort, date windows, handle filters, post capture
- [docs/x-api.md](docs/x-api.md) — x_api X API v2 operations, operators, pagination, cost guidance
- [docs/exa.md](docs/exa.md) — exa_search settings: types, contents packing, categories, filters, answer, contents
- [docs/firecrawl.md](docs/firecrawl.md) — `firecrawl_search` SERP + papers/developer indexes; `firecrawl_crawl` map/scrape/crawl/batch/extract/agent/interact, page limits, and per-page cost
- [docs/capability-catalog.md](docs/capability-catalog.md) — planning table: every native + extended + keyless capability, costs as **guidance**, chosen vs rejected
- [docs/capability-matrix.md](docs/capability-matrix.md) — source-verified audit of what every tool can and cannot do (a snapshot; re-run the audit rather than hand-editing it)
- [docs/parallel.md](docs/parallel.md) — parallel_search settings: modes, extract, task processors
- [docs/tavily.md](docs/tavily.md) — tavily_search settings: search/extract/map/crawl/quota

### Deep-research skill (plan-first gate)

- [`.agents/skills/deep-research/SKILL.md`](.agents/skills/deep-research/SKILL.md) — visible capability plan in the chat message (Chosen / Rejected / cost estimate / numbered how-to-proceed options) → STOP → wait for a reply. Do not use the `ask` tool. Copied to `~/.omp/agent/skills/deep-research/` with `--with-confirm-rule`.

Install into omp with `./install.sh … --with-confirm-rule` (copies the skill and removes any leftover alwaysApply confirm rule).

## Notes

- `x_search` used to live at [omp-x-search](https://github.com/bnivanov/omp-x-search). That repo is archived; this one is its home now.
- `x_api` is a separate billed X API v2 lane (`X_BEARER_TOKEN`). It never reads `XAI_API_KEY`.
- `firecrawl_search` resolves credentials in this order: omp session/provider Firecrawl credential, `FIRECRAWL_API_KEY`, then limited keyless access.
- License: [MIT](./LICENSE)
