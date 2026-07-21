# omp-extended-search

Extra search tools for the [omp](https://omp.sh) coding agent. omp's built-in `web_search` covers everyday lookups; these tools add backends it exposes poorly or not at all. Each tool is one self-contained TypeScript file — no build step, no dependencies, survives omp upgrades.

Install only the ones you want.

| Tool | File | What it does | Credentials |
|---|---|---|---|
| X Search | `tools/x_search.ts` | Searches public posts on X (Twitter) via xAI's native search. Keyword, semantic, user, and thread search; can optionally resolve each cited post to its real text and engagement numbers. | `/login` → xAI Grok (SuperGrok or X Premium+), or `XAI_API_KEY` |
| Exa Search | `tools/exa_search.ts` | Full Exa API: search types (`auto` / `fast` / `neural` / `deep`), vertical categories (papers, people, companies, github), domain/date filters, answer-with-citations, URL contents fetch. omp's native Exa path only ever uses `auto` + summary. | `/login` → Exa, or `EXA_API_KEY` |
| Parallel Search | `tools/parallel_search.ts` | Full Parallel V1 API: search modes (`turbo` / `basic` / `advanced`) with objective + multi-query support, URL extract, and deep-research task processors (`lite` … `ultra8x`). omp's native path hardcodes the old beta `fast` mode. | `/login` → Parallel, or `PARALLEL_API_KEY` |

## Install

```bash
git clone https://github.com/bnivanov/omp-extended-search
cd omp-extended-search

./install.sh x               # just X search
./install.sh exa parallel    # just Exa and Parallel
./install.sh all             # everything
./install.sh                 # prints help, installs nothing
```

Or grab a single tool without cloning the repo:

```bash
mkdir -p ~/.omp/agent/tools
curl -fsSL https://raw.githubusercontent.com/bnivanov/omp-extended-search/main/tools/x_search.ts \
  -o ~/.omp/agent/tools/x_search.ts
```

For a project-level install, copy the file into `<your-project>/.omp/tools/` instead. Either way, restart any open omp session afterwards so the new tools are discovered.

## Usage

Just ask in chat — the model picks the tool from your wording:

- "What's being said on X about the latest omp release?"
- "Use exa for search: recent papers on agent memory"
- "Use parallel for search: compare agent memory backends"
- "Use your normal web search and expand with Exa and Parallel"

## Optional: confirm-before-search gate

These tools spend API credits, and their settings change cost and latency. If you'd rather have the agent propose a plan and wait for your OK before searching:

```bash
./install.sh all --with-gate
```

That installs a recommend-first rule for the tools you selected and sets `tools.approval.<tool>: allow` in `~/.omp/agent/config.yml`. Set the policy to `prompt` if you want a hard approval dialog before every call instead. More in the per-tool docs.

## Docs

- [docs/x.md](docs/x.md) — x_search settings: focus, reasoning effort, date windows, handle filters, post capture
- [docs/exa.md](docs/exa.md) — exa_search settings: types, contents packing, categories, filters, answer, contents
- [docs/parallel.md](docs/parallel.md) — parallel_search settings: modes, extract, task processors

## Notes

- `x_search` used to live at [omp-x-search](https://github.com/bnivanov/omp-x-search). That repo is archived; this one is its home now.
- Auth resolution in every tool: omp session credentials first, environment variables as fallback.
- License: [MIT](./LICENSE)
