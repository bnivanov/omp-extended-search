# omp-extended-search

Extra search tools for the [omp](https://omp.sh) coding agent. omp's built-in `web_search` covers everyday lookups; these tools add backends it exposes poorly or not at all. Each tool is one self-contained TypeScript file — no build step, no dependencies, survives omp upgrades.

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
| Exa Search | `tools/exa_search.ts` | Full Exa API: search types (`auto` / `fast` / `neural` / `deep`), vertical categories (papers, people, companies, github), domain/date filters, answer-with-citations, URL contents fetch. omp's native Exa path only ever uses `auto` + summary. | `/login` → Exa, or `EXA_API_KEY` |
| Parallel Search | `tools/parallel_search.ts` | Full Parallel V1 API: search modes (`turbo` / `basic` / `advanced`) with objective + multi-query support, URL extract, and deep-research task processors (`lite` … `ultra8x`). omp's native path hardcodes the old beta `fast` mode. | `/login` → Parallel, or `PARALLEL_API_KEY` |

## Install

```bash
git clone https://github.com/bnivanov/omp-extended-search
cd omp-extended-search

./install.sh hackernews feed arxiv   # the free, no-key tools
./install.sh x                      # just X search
./install.sh exa parallel           # just Exa and Parallel
./install.sh reddit                 # just Reddit
./install.sh all                    # everything
./install.sh                        # prints help, installs nothing
```

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
- "Use parallel for search: compare agent memory backends"
- "Use your normal web search and expand with Exa and Parallel"

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
```

**Common failure mode:** writing to `xdi://…` or a bare filename creates a
normal file/directory in the workspace and **never runs the tool**. Always use
the exact prefix **`xd://`** plus the tool name (`hackernews_search`,
`x_search`, …).

Built-in `web_search` may still appear as a native tool *or* as `xd://web_search`
depending on omp version — prefer whatever the session already exposes; do not
invent a third URI.

## How it works with omp

1. **Install** the tool files into `~/.omp/agent/tools/` (or a project `.omp/tools/`).
2. **Restart omp** — it picks up new tool files and mounts them under `xd://<name>`.
   Sanity check: `read xd://hackernews_search` (or another installed tool) returns a schema.
3. **Built-in `web_search` stays the default** for everyday lookups. These tools add lanes omp covers poorly or not at all (X, HN, Reddit, PH, arXiv, feeds, full Exa/Parallel, GitHub discovery). You can mix them: “use normal web search and also check HN + Reddit.”
4. **Optional plan-first gate** — with the global confirm rule installed, the agent does **not** fire searches immediately. It proposes which sources to use, how to structure each request, and waits for your OK — one rule over web_search and every extended tool (including X). After approval, it invokes via `write` to `xd://…` as above.

## Optional: confirm-before-search gate

Settings change cost, latency, and which corner of the internet you hit. If you'd rather shape the research in chat first:

```bash
./install.sh all --with-confirm-rule
# shorthand that also writes tools.approval.<tool>: allow (harmless under yolo):
./install.sh all --with-gate
```

That installs one global recommend-first **agent rule** ([rules/omp-search-confirm.md](rules/omp-search-confirm.md)) covering built-in `web_search` and every extended tool (HN, Reddit, PH, GitHub, arXiv, feeds, X, Exa, Parallel).

**Intended UX:** the model proposes sources + parameters in the chat and waits for your “go” / tweaks. It is **not** a per-call “Approve x_search?” popup. Keep `tools.approvalMode: yolo` (omp default for many setups) or per-tool `allow` so tools run quietly after you approve the plan in chat. Only set a tool to `prompt` if you *want* a hard UI dialog every call. Say “just search” anytime to skip the chat gate for one request.

## Docs

- [docs/hackernews.md](docs/hackernews.md) — HN search + feed parameters
- [docs/feed.md](docs/feed.md) — feed bundles, filters, and how to build Substack/Medium/Google News feed URLs
- [docs/arxiv.md](docs/arxiv.md) — arXiv search parameters
- [docs/reddit.md](docs/reddit.md) — Arctic Shift archive (no Reddit app) and search parameters
- [docs/github.md](docs/github.md) — repo search qualifiers
- [docs/producthunt.md](docs/producthunt.md) — token setup and parameters
- [docs/x.md](docs/x.md) — x_search settings: focus, reasoning effort, date windows, handle filters, post capture
- [docs/exa.md](docs/exa.md) — exa_search settings: types, contents packing, categories, filters, answer, contents
- [docs/parallel.md](docs/parallel.md) — parallel_search settings: modes, extract, task processors

### Agent rule (plan-first gate)

- [rules/omp-search-confirm.md](rules/omp-search-confirm.md) — **global** rule (`alwaysApply`): propose source mix + settings across `web_search` and every extended tool, wait for chat OK. Not X-only.

Install into omp with `./install.sh … --with-confirm-rule` (copies it to `~/.omp/agent/rules/`), or copy the file there yourself.

## Notes

- `x_search` used to live at [omp-x-search](https://github.com/bnivanov/omp-x-search). That repo is archived; this one is its home now.
- Auth resolution in every tool: omp session credentials first, environment variables as fallback.
- License: [MIT](./LICENSE)
