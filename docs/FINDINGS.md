# Findings log

Append-only. Newest entry first. Record what we tested, what broke, what we added or removed, and what we decided not to do.

Public repo: https://github.com/bnivanov/omp-extended-search
Do not push an entry until the exact text has been reviewed in chat.

---

## 2026-08-22 — Hermes vs omp-extended-search (how they are set up)

Status: **comparison**. File-verified against VPS `deep-research` v2.6.4 + this repo. No code changed.

Earlier entries captured arm health and "what to port." They did **not** capture the architecture difference. This entry does.

Hermes already adapted our vendor parameter maps (`references/vendor-parameters.md` says so). They put a **method OS** on top. We shipped **lanes** and stopped.

### Shape

| | Hermes (VPS) | omp-extended-search |
|---|---|---|
| Unit of design | One umbrella **skill** | Eleven independent **tools** + one optional **rule** |
| Everyday search | `web_search` / `web_extract` with a **single active backend** | Built-in `web_search` **chain** (interactive: 23 providers; this `hermes-jobs` profile: Brave → public only) |
| How you pick a vendor | `hermes config set web.search_backend exa\|brave-free\|…` — reread **per call**, global, restore after | Call an explicit `xd://exa_search` / `xd://parallel_search` / … lane. No backend flip |
| Advanced vendor surfaces | Plugins expose only `search()` + `extract()`. Agent / research / interact / map / crawl go through CLI / SDK / `execute_code` | Same surfaces are first-class tool ops (`exa_search` type/answer/contents, `parallel_search` search/extract/task, `firecrawl_search` + `firecrawl_crawl`) |
| Site platforms (HN, RSS, arXiv, Reddit, GH, PH, X) | Curl recipes inside the skill (except `x_search`) | Dedicated `xd://` tools |
| Plan-first gate | **Inside the skill**, first section. Plan and first fetch never same turn | Optional `rules/omp-search-confirm.md` (`alwaysApply`). No skill. Easy to ignore if the rule is off or the profile does not load it |
| Citations | Mandatory companion doctrine + `sources.py` ledger + verify | Whatever the provider returns. No ledger, no verify |
| Cost | Skill ceilings + log every leg incl. $0 + 8c hunt scorecard + `/usage` chip | No per-call spend guard. Cost reported after the fact on some tools |
| JS / login walls | Firecrawl interact (paid, last resort) then browser | `xd://browser` (and Firecrawl crawl is public pages only) |
| Reddit | **Search** = Brave `site:reddit.com`. **Read** = Arctic Shift **ids/comments**. `query=` is dead | `reddit_search` hits Arctic Shift `query=` (today: timeout then success) |
| Defaults | search = Exa, extract = Firecrawl | Everyday = native `web_search`. Extended tools only when named or the rule routes there |
| Fallback | Configured-but-missing-key falls through. **Runtime error does not** auto-fallback | Native chain walks the next provider. Explicit `xd://` lanes fail in place |
| Where it lives | One VPS profile, keys in env, config file guarded | Copied into `~/.omp/agent/tools`. **Profiles do not inherit that dir** |
| Research skill on omp | n/a | Never built. `EVAL.md` only. `deep-research-scout` exists and is **disabled** + `read`-only |

### What each side already owns

Hermes owns: gate, routing table, citation contract, ceilings, 8b/8c logging, Reddit search-vs-read, X usable-cite, "don't recreate Parallel tasks", free-API recipes (OpenAlex, Wayback, yt-dlp).

We own: the actual omp-native lanes (and Hermes copied our param maps). Also omp `read(URL)` scrapers (~78) that Hermes still writes as curl.

Neither side has a hard dollar deny at call time.

### The mismatch that makes ours feel worse

1. **Lanes without a conductor.** Eleven tools + native chain, no skill telling the model which lane, when, or when to stop.
2. **Gate is a rule, not the skill.** Hermes cannot start retrieval in the plan turn. We can, unless the confirm rule is loaded and obeyed.
3. **Reddit tool fights Hermes's probed recipe.** We search AS with `query=`; they marked that dead and search via Brave.
4. **Profile split.** Interactive bank has outdated tools. `hermes-jobs` has none.
5. **Citations and 8c are missing.** Synthesis quality is unenforced and unlogged.

### Implication (unchanged)

Do not add providers. Restore `POSTS_QUERY`, fix profile install, then add **one** omp skill that is the conductor. Keep `xd://` as the wiring.

### Add / remove tracker

| Date | Change | Where |
|---|---|---|
| 2026-08-22 | Logged Hermes-vs-omp architecture comparison | `docs/FINDINGS.md` |

---

## 2026-08-22 — Hermes deep-research v2.6.4 read from VPS

Status: **skill read**. No tool code changed. No public push.

### Access

`ssh hermes-watchtower` (user key, not the jobs key) works. The skill is:

`/home/hermes/.hermes/skills/research/deep-research/`

- `SKILL.md` — version **2.6.4**, internal license
- `references/` — `free-research-apis.md`, `free-tier-recipes.md`, `grounded-citations.md`, `hermes-web-provider-config.md`, `omp-research-architecture.md`, `provider-usage.md`, `vendor-parameters.md`

Earlier "permission denied" was the **jobs** host/key. Mac bundled Hermes skills still do not include this file.

Do not copy the VPS file into the public repo. Port method text only.

### What the skill actually is

Method + VPS wiring. The wiring (Hermes `config set web.search_backend`, env file, usage patchers) stays on the VPS.

Portable method, now file-verified (step 8c included):

1. **HARD GATE at the top.** Plan (goal, tools+settings, why non-defaults, cost/latency) → end the turn → wait. "Research X" authorizes the topic, not a skip. Skip only: "just search", exact tools named, or plan already approved this session.
2. **Routing table.** Known platform → site API. Factoid/news → Brave. Semantic → Exa. Extract → Firecrawl. Light deep → Exa Agent cheap tier. Heavy deep → Parallel, budget first. Social/scholarly/dead-link rows are explicit.
3. **Ceilings.** Standard < $0.05 · light deep < $0.10 · heavy $1–2.40 pre-approved. Parallel above pro-fast never without a stated budget.
4. **Citations mandatory** (6b). Reset ledger → register at retrieval → cite while drafting → verify. Snippet ≠ page. `[unverified]` for model knowledge.
5. **Log every leg including $0** (8b). Quality = usable answer, not HTTP 200.
6. **Score the hunt** (8c). After real research: win/mixed/fail + best tool + worst tool + one-line lesson. Cost log alone is not enough.
7. **Reddit.** Search via Brave `site:reddit.com`. Read via Arctic Shift **ids/comments**, not `query=`. Space calls; `query=`+subreddit 422/timeout. Matches today's flaky Reddit probe.
8. **X.** Pin grok-4.3@high for topic sweeps. Score usable cites: handle + date + permalink. `/i/status` is unusable until capture rewrite. `x_search_calls=0` → distrust.
9. **Parallel.** Never cancel (DELETE 405). Recover via `task_status` + run id. Never re-create.
10. **Firecrawl.** Map before crawl. `limit` is per source. Interact is last resort; on omp, escalate to `xd://browser` instead.

### What this changes vs the first audit

| Prior guess | File-verified |
|---|---|
| 8c wording uncertain | 8c is a qualitative hunt scorecard (win/mixed/fail + best/worst + lesson), not another cost field |
| Reddit `query=` maybe dead | Confirmed dead; Brave search + AS by id is the recipe |
| Take citations + Wayback | Still the highest-value ports; plus 8c scorecard and the Reddit split (search vs read) |
| Exa Agent as a skill default | **Do not port the wiring.** omp already has `exa_search` / `parallel_search`. Port the *ladder* (cheap structured first, Parallel only when pre-approved) |

### Fix list, revised

Keep the first-audit mechanical fixes (restore `POSTS_QUERY`, profile install path, don't blanket-update).

From this skill, into omp — **text, not VPS code**:

| Add | Where |
|---|---|
| HARD GATE wording (topic ≠ skip; plan and first fetch never same turn) | skill `SKILL.md` §0; already partly in `rules/omp-search-confirm.md` — merge, don't double-prompt |
| Reddit search-vs-read split + AS timeout note | `docs/reddit.md` + skill routing row |
| X usable-cite + `/i/status` rewrite + `x_search_calls` distrust | `docs/x.md` + skill |
| 8c hunt scorecard (no VPS script) | skill + optional `usage-log.jsonl` / `RUNS.md` in the research workspace |
| OpenAlex / Wayback / yt-dlp recipes | skill `references/free-apis.md` |
| Map-before-crawl + per-source limit | already in Firecrawl docs; promote into the routing table |

| Still reject |
|---|
| Hermes backend switcher / env / usage patch scripts |
| Firecrawl interact recipe as the JS path (use `xd://browser`) |
| GDELT / Semantic Scholar as defaults (skill itself marks them skipped/429) |
| Copying SKILL.md verbatim into the public repo |

### Add / remove tracker

| Date | Change | Where |
|---|---|---|
| 2026-08-22 | Logged VPS skill read (v2.6.4) | `docs/FINDINGS.md` |

---

## 2026-08-22 — first live arm audit

Status: **diagnosis only**. No tool code changed. No public push.

### Surfaces checked

| Surface | State |
|---|---|
| Public repo `main` | `db94b64` — same as `origin/main` |
| Installed copies | `~/.omp/agent/tools/` — 10 files, **all outdated** vs repo |
| `firecrawl_crawl` | in repo, **not installed** |
| This session (`hermes-jobs`) | custom tools **not mounted** (`xd://hackernews_search` etc. missing) |
| Native `web_search` | mounted; profile order is `brave` then `public` only |
| omp deep-research skill | **never built** — `omp-deep-research/EVAL.md` is eval-only |
| `deep-research-scout` agent | exists at `~/.omp/agent/agents/deep-research-scout.md`; **disabled** in interactive `task.disabledAgents` |
| Hermes `deep-research` v2.6.4 | **not on this Mac**. Bundled Hermes research skills have no `deep-research`. VPS read via `hermes-watchtower` → `Permission denied (publickey)` |
| Hermes skills actually present | `grounded-citations`, `blocked-page-recovery`, `arxiv`, `research-paper-writing`, optional `parallel-cli` |
| Plan-first rule | installed at `~/.omp/agent/rules/omp-search-confirm.md` (`alwaysApply`) |

### Why the fleet "isn't working" in this session

omp 17.3.7 loads native custom tools from the **active profile** agent dir, not from the interactive bank:

```
~/.omp/profiles/<name>/agent/tools
```

`install.sh` still copies into `~/.omp/agent/tools`. Interactive omp sees that directory. `hermes-jobs` does not. That is why this session can run built-in `web_search` and cannot see any extended arm.

### Live probe (repo tools, standalone Bun factory, cheap modes)

Harness invoked each tool's `execute()` directly. That bypasses `xd://` mounting, so it tests the **code + APIs**, not profile discovery.

| Arm | Result | Notes |
|---|---|---|
| native `web_search` | **pass** | 10 results; omp.sh + can1357/oh-my-pi present |
| `hackernews_search` | **pass** | 2 hits, 429 ms |
| `feed_search` | **pass** | tech-news bundle, 3 items |
| `arxiv_search` | **pass** | 347 upstream; param is `max_results`, not `limit` |
| `reddit_search` | **flaky** | first call: Arctic Shift timeout on r/LocalLLaMA; retry + default-subs: pass (4.5s / 15s) |
| `github_search` | **pass** | 358 matches, 3 returned |
| `producthunt_search` (repo) | **fail** | `POSTS_QUERY is not defined (after 3 attempts)` |
| `producthunt_search` (installed) | **pass** | installed copy still has the GraphQL query; 3 launches |
| `x_search` | **auth miss** (standalone) | factory needs `host.arktype`; then `xAI credentials not found`. `XAI_API_KEY` unset; session xAI OAuth is not visible to a standalone probe |
| `exa_search` | **pass** | `type=fast`, `contents=none`, 3 results |
| `firecrawl_search` | **pass** | 3 web results, 3.2s |
| `firecrawl_crawl` | **pass** | `map` on omp.sh, 5 URLs |
| `parallel_search` | **pass** | `mode=turbo`, 3 results |

### Code bug: Product Hunt query dropped on GitHub

`const POSTS_QUERY` exists in the installed file and was removed from repo `tools/producthunt_search.ts` in `0f740fc` (2026-07-26, resilience pass). `fetchPosts` still references it. **`./install.sh update` would ship the broken file over the working install.**

Do not run a blanket update until that constant is restored.

### Hermes comparison — what to take, what not to

Hermes custom `deep-research` v2.6.4 is still only bank-reconstructed (see `omp-deep-research/EVAL.md`). What we *can* read on disk today:

| Take | Source | Why |
|---|---|---|
| Citation ledger + verify-before-deliver | `grounded-citations` | Highest-value method. omp renders Sources when a provider sends them; nothing enforces register-at-retrieval / `[n]` / `[unverified]` |
| Blocked-page ladder | `blocked-page-recovery` | Wayback `available` + CDX, archive.today domain rotation, fake-success rejection. Matches the EVAL "port Wayback recipe" row |
| Arctic Shift is fragile | this probe + Hermes Reddit notes | Timeout is real. Need retry/backoff already in tool, plus routing text: slow down, fewer subs, don't treat one timeout as "Reddit is dead" |
| Don't recreate Parallel tasks | Hermes `parallel-cli` + EVAL | Poll `task_status` by run id. We did **not** fire a Parallel `task` processor in this audit (cost) |
| X usable-cite | EVAL / v2.6.3 | handle + date + permalink; rewrite `x.com/i/status`. Only useful once `x_search` actually runs in-session |
| Cost ceilings in the plan | EVAL D5 | still no per-call spend guard. Gate + stated budget is the control |

| Leave | Why |
|---|---|
| Hermes provider CLIs / curl wiring | REJECT still holds. Exa / Parallel / Firecrawl / X already exist as `xd://` tools |
| `research_log.py` / `account_usage.py` / cron | VPS-specific |
| Bundled Hermes `arxiv` curl recipes | our `arxiv_search` already works |
| `parallel-cli` as a second Parallel path | duplicates `parallel_search.ts` |
| Disabled `fanned-search` MCP skill | old Exa MCP + `parallel_search_paid` names; superseded by this fleet |

### Recommendations (proposed add/remove)

**Do now (functional, small)**

1. Restore `POSTS_QUERY` in `tools/producthunt_search.ts` from the installed copy. Add a smoke assertion so a nameless GraphQL constant cannot compile-run.
2. Teach `install.sh` (or the README) that **profiles do not inherit** `~/.omp/agent/tools`. Either copy into `~/.omp/profiles/<name>/agent/tools` or document `DEST_DIR` override.
3. Do **not** `./install.sh update` until (1) lands. After it lands, update the interactive bank and install `firecrawl-crawl` only if we want crawl in that bank.

**Do next (method, not more providers)**

4. Add a thin omp skill `deep-research` as outlined in `EVAL.md` §6: plan-first via `ask`, routing table, ceilings, citation contract. One skill. Do not add a second alwaysApply confirm rule — `omp-search-confirm.md` already covers the gate.
5. Port `grounded-citations` as `references/citations.md` + a tiny ledger script, not Hermes's `$HERMES_HOME` path.
6. Port the blocked-page ladder as `references/free-apis.md` (Wayback / archive.today). Escalate JS/login walls to `xd://browser`, not Firecrawl interact.
7. Re-enable or delete `deep-research-scout`. Disabled + present is worse than either choice. If kept, give it `web_search` / `xd://` tools; today it is `read`-only and cannot scout the live web.

**Do not add**

- Another search provider.
- A Parallel `ultra*` default.
- Hermes VPS usage machinery.
- A second plan-first rule.

### Add / remove tracker

| Date | Change | Where |
|---|---|---|
| 2026-08-22 | Added this log | `docs/FINDINGS.md` |
| — | No tool functions added or removed | — |

### Open threads

- In-session `x_search` still unproven: needs the tool mounted **and** xAI OAuth from `/login`.
- Parallel `task` processors (`lite`…`ultra8x`) not live-tested (cost).
- Firecrawl `crawl` (billed multi-page) not live-tested; only `map`.
- Hermes v2.6.4 SKILL.md still unread from the VPS.

### Next steps

1. Review this entry. If approved, commit it on `main` (push only after explicit go).
2. Restore `POSTS_QUERY`.
3. Decide profile install story before any `update`.
4. Then build the skill, not more tools.
