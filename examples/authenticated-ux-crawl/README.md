# Worked example: authenticated UX/UI crawl

A crawl of a **logged-in** web app, reviewed by parallel agents. This exists because none of the
tools in this repo can do it: Firecrawl sends no cookies or session, so `firecrawl_crawl` reaches
public pages only, and every search tool needs URLs you already have. Behind a login, the crawl has
to be driven through omp's `xd://browser` device — this is what that looks like end to end.

Target was a live Raft workspace (`app.raft.build`), 22 screens, 119 findings.
[`findings.json`](./findings.json) holds the structured output; screenshots and raw accessibility
trees are deliberately **not** committed — they contain workspace content.

## Method

```
xd://browser open + run          →  22 screens, each captured as PNG + ARIA snapshot
   ↓
4 review agents in parallel      →  designer × 3 (chat / navigation / settings)
   (each reads only its cluster)     reviewer × 1 (accessibility + naming consistency)
   ↓
structured schema per finding    →  severity, category, screens, evidence, recommendation
```

Each agent was required to run `xd://inspect_image` on the screenshot **and** read the ARIA snapshot
for every screen in its cluster, and to quote the visible string or ARIA node behind each finding.
Splitting by cluster keeps each agent's context small enough to read every artifact properly; the
accessibility pass runs across *all* trees precisely because its defects are cross-cutting.

## Reproducing it

The browser device runs its own Chromium profile, so it does not inherit your Chrome session. Open
the target, log in manually in the visible window, then drive the crawl.

```jsonc
// 1. open — lands on the login page the first time
{"action":"open","name":"app","url":"https://example.com/dashboard","wait_until":"networkidle2"}

// 2. log in by hand in the visible window, then verify
{"action":"run","name":"app","code":"const s=await tab.ariaSnapshot(); return {signedIn:!/Sign In/.test(s)};"}

// 3. capture each screen
{"action":"run","name":"app","code":"const fs=require('fs'); await page.screenshot({path:`/tmp/crawl/${k}.png`}); fs.writeFileSync(`/tmp/crawl/${k}.aria.txt`, await tab.ariaSnapshot());"}
```

Three things cost us a retry, worth knowing up front:

- **Ambiguous accessible names.** `tab.click("aria/Tasks")` hit the global rail, not the channel tab
  of the same name, and navigated away — breaking every subsequent click in that cell. Scope the
  query (`document.querySelector('[role=tablist]')`) when a name is not unique.
- **Refs die on navigation.** `[ref=eN]` handles are invalidated by any navigation or re-render.
  Re-snapshot and act in the same cell.
- **Capture both modalities.** The ARIA tree finds unnamed controls and duplicated radios that a
  screenshot cannot show; the screenshot finds contrast and hierarchy failures the tree cannot. Half
  the findings here are only visible in one of the two.

## What it found

| Severity | Count |
|---|---|
| blocker | 7 |
| high | 42 |
| medium | 51 |
| low | 19 |

The value of the fan-out shows up in the *systemic* findings — the ones no single-screen review
surfaces. Roughly 35 of 119 trace to two root causes: every custom radio and switch exposes both the
styled element and the native input (so each segmented control offers double the options, half of
them unnamed), and the app has no landmarks and no `h1` on any screen. Both are one-line fixes in a
shared component that repay across every screen in the product.
