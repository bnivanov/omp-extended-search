---
name: deep-research
description: Plan-first multi-source research. Use for any live web, news, social, papers, repos, feeds, comparisons, or synthesis — including “research”, “look up”, “find sources”, “what’s the latest”, and “compare”. Before retrieving, write a visible capability plan in the chat message with chosen vs rejected, cost estimate, and how-to-proceed options, then STOP and wait for a reply. Do not use the ask tool.
---

# Deep Research Pipeline

Construct a mix from the **capability catalog**. There is no “first use this” ladder.

The gate lives **in this skill**. There is no alwaysApply confirm rule. Do **not** call the `ask` tool — it clashes with a visible plan. The plan is a normal chat message.

---

## §0. HARD GATE — Visible plan in the message, then stop

**Before any retrieval** (`web_search`, any `xd://` research tool, `read` of a live URL for research, `browser` for facts):

1. Open `skill://deep-research/references/capability-catalog.md`.
2. Write the plan **in the visible assistant message** the user can read. Thinking / scratchpad **does not count**.
3. End with **How to proceed** as numbered text options (recommended mix first, then cheaper / $0 / drop-paid variants that still could work).
4. Ask how to proceed. **STOP. End the turn.** Zero retrieval in the plan turn. Zero `ask` tool calls.

Skip **only** if the user said “just search”, named exact tool+settings to run now, already picked an option for this plan, or the task needs no live outside research.

“Research X” is not a skip.

### Plan shape (copy into the visible message)

```text
## Research plan
Objective: <one sentence>
Angles: <2–4 sub-queries>

### Chosen
- <capability / tool / knobs> — why this answers the angle

### Rejected (plausible but unused)
- <capability> — why not (wrong corpus, cost, overlap, login wall)
- … (near-misses: developer index vs github_search, scrape JSON vs agent, Parallel task vs Exa)

### Cost & limits (guidance, not a quote)
- Legs: <tool> × N → ~<credits or $>
- Total: ~$X / ~N credits  |  latency: …
- Ceilings used: <page limit / max_credits / processor>
- Free-tier notes: <keyless limits if relevant>

### How to proceed
1. Run as written (recommended)
2. Cheaper mix: <what changes>
3. $0 only: <keyless / native-only mix>
4. Tweak: tell me what to drop or add

Reply with a number or a tweak.
```

Do not bury Chosen / Rejected / Cost / options in thinking.

---

## §1. How to pick (not a priority list)

The map: `skill://deep-research/references/capability-catalog.md`  
Domain candidates (options, not first-choice): `skill://deep-research/references/routing-table.md`  
Keyless recipes: `skill://deep-research/references/free-apis.md`

- Open the catalog. Every row is in play, including `x_search` and every `x_api` operation. The model picks the mix.
- `Best for` / `Not for` / cost on the row are facts. Do not invent a separate ladder.
- Rejected must include near-misses the user would otherwise ask about.
- Name ceilings from the chosen rows (Firecrawl `limit` / `max_credits`, Parallel processor, `x_api` `max_results`). Parallel `pro`+ and Firecrawl agent / crawls >20 pages need an explicit budget in Chosen.

Say “guidance, not a quote”. No per-call spend guard exists.

After the user picks an option, run only that mix via `write` to `xd://<tool>` (or native `web_search` / `read` / `browser` as planned). Wrong prefix `xdi://` creates a file and does not run. If results leave a gap, write a **new** plan before spending more.

---

## §2. Citations

Follow `skill://deep-research/references/citations.md`.

- Inline `[n]` on every retrieved fact. `## Sources` at the end with URLs and access date.
- `[unverified]` for model prior.
- X: `https://x.com/{handle}/status/{id}` + handle + date.

---

## §3. After the hunt

If you actually retrieved: one-line score (win / mixed / fail), best capability, worst capability, one lesson. Cost log alone is not enough.
