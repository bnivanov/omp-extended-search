---
name: x-search-confirm
description: "Before calling x_search, propose recommended settings and get the user's approval"
alwaysApply: true
---

# Confirm x_search settings before searching

When the user asks for anything that should run through the `x_search` tool (X/Twitter posts, accounts, threads, live public discourse), do **not** call the tool immediately. First propose a search plan and wait for the user's go-ahead.

## Workflow

1. **Restate the search goal** in one line.
2. **Recommend settings** as a short bullet list, with a one-clause reason for each non-default choice:
   - `focus` — `relevance` (default) for "what's the best / is it X" or any pointed question; `volume` only when the goal is breadth, sentiment sweep, or discovering many handles. (Empirically, on a pointed query `relevance` returns more distinct entities per source; `volume` returns more raw posts but with more repetition.)
   - `reasoning_effort` — `high` (default) for depth/historical reach; `low`/`medium` for a quick pulse.
   - `limit` — default `10`; raise toward `30` for volume sweeps, lower (e.g. `5`) for a tight answer.
   - `from_date`/`to_date` or `recency` — pin an explicit window whenever the topic is time-sensitive.
   - `allowed_handles`/`excluded_handles` — pin handles when the user named specific accounts.
   - `capture` — enable when the user wants the real post text/engagement, not just Grok's summary. Use `syndication` (free) by default; only use `capture_provider: firecrawl` when the user explicitly wants retweet counts / top replies and accepts Firecrawl credit spend.
   - `model` — leave at the default unless the user wants premium synthesis (`grok-4.5`).
3. **Ask the user to approve or adjust.** If they change parameters, restate the final plan.
4. **Only then call `x_search`.** The tool is also configured to show an approval prompt with the resolved settings; approving there runs the search, rejecting it means revise and re-propose.

Keep the proposal terse — a goal line plus the settings bullets. Do not pad it with caveats the user already knows.
