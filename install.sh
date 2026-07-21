#!/usr/bin/env bash
# Install omp-extended-search tools into ~/.omp/agent/tools.
# You pick which tools to install; running this with no arguments installs nothing.
#
#   ./install.sh x                  install x_search only
#   ./install.sh exa parallel       install exa_search + parallel_search
#   ./install.sh hackernews feed    install the free, no-key tools
#   ./install.sh all                install every tool
#
# Opt-in extras (applied to the selected tools only):
#   --with-confirm-rule    also install the recommend-first agent rule(s) into ~/.omp/agent/rules
#   --with-approval-gate   also set tools.approval.<tool>: allow in ~/.omp/agent/config.yml
#   --with-gate            both of the above
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.omp/agent/tools"
RULES_DIR="${HOME}/.omp/agent/rules"
CONFIG_YML="${HOME}/.omp/agent/config.yml"

WITH_CONFIRM_RULE=0
WITH_APPROVAL_GATE=0
SELECTED=()

usage() {
  cat <<'EOF'
Usage: ./install.sh <tool> [tool...] [--with-confirm-rule] [--with-approval-gate] [--with-gate]

Tools (pick one or more):
  x            x_search.ts           — public posts on X (Twitter) via xAI
  exa          exa_search.ts         — full Exa search/answer/contents
  parallel     parallel_search.ts    — full Parallel V1 search/extract/task
  hackernews   hackernews_search.ts  — Hacker News search + front-page feeds (no key)
  feed         feed_search.ts        — RSS/Atom reader for blogs/newsletters/news (no key)
  arxiv        arxiv_search.ts       — arXiv paper search (no key)
  reddit       reddit_search.ts      — Reddit search via the official API (free app creds)
  github       github_search.ts      — GitHub repo search, trending/new projects
  producthunt  producthunt_search.ts — Product Hunt launches (free API token)
  all          all of the above

Extras (opt-in, applied to selected tools):
  --with-confirm-rule    install the recommend-first agent rule(s)
  --with-approval-gate   set tools.approval.<tool>: allow in config.yml
  --with-gate            both extras

With no tool arguments this prints the help and installs nothing.
EOF
}

for arg in "$@"; do
  case "$arg" in
    x|exa|parallel|hackernews|feed|arxiv|reddit|github|producthunt) SELECTED+=("$arg") ;;
    all) SELECTED=(x exa parallel hackernews feed arxiv reddit github producthunt) ;;
    --with-confirm-rule) WITH_CONFIRM_RULE=1 ;;
    --with-approval-gate) WITH_APPROVAL_GATE=1 ;;
    --with-gate)
      WITH_CONFIRM_RULE=1
      WITH_APPROVAL_GATE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "${#SELECTED[@]}" -eq 0 ]]; then
  usage
  exit 0
fi

# De-duplicate while preserving order.
UNIQUE=()
for s in "${SELECTED[@]}"; do
  seen=0
  for u in "${UNIQUE[@]:-}"; do [[ "$u" == "$s" ]] && seen=1 && break; done
  [[ "$seen" -eq 0 ]] && UNIQUE+=("$s")
done
SELECTED=("${UNIQUE[@]}")

tool_file() { echo "$1_search.ts"; }

wants() {
  local needle="$1"
  for s in "${SELECTED[@]}"; do [[ "$s" == "$needle" ]] && return 0; done
  return 1
}

mkdir -p "$DEST_DIR"
for s in "${SELECTED[@]}"; do
  f="$(tool_file "$s")"
  if [[ ! -f "$ROOT/tools/$f" ]]; then
    echo "error: tools/$f not found in this repo" >&2
    exit 1
  fi
  cp "$ROOT/tools/$f" "$DEST_DIR/$f"
  echo "Installed tools/$f -> ${DEST_DIR}/$f"
done

if [[ "$WITH_CONFIRM_RULE" -eq 1 ]]; then
  mkdir -p "$RULES_DIR"
  if wants x; then
    cp "$ROOT/rules/x-search-confirm.md" "$RULES_DIR/x-search-confirm.md"
    echo "Installed rule -> ${RULES_DIR}/x-search-confirm.md"
  fi
  if wants exa || wants parallel; then
    cp "$ROOT/rules/omp-search-confirm.md" "$RULES_DIR/omp-search-confirm.md"
    echo "Installed rule -> ${RULES_DIR}/omp-search-confirm.md"
  fi
fi

if [[ "$WITH_APPROVAL_GATE" -eq 1 ]]; then
  mkdir -p "$(dirname "$CONFIG_YML")"
  TOOL_NAMES=()
  for s in "${SELECTED[@]}"; do TOOL_NAMES+=("${s}_search"); done
  if [[ ! -f "$CONFIG_YML" ]]; then
    {
      echo "tools:"
      echo "  approval:"
      for t in "${TOOL_NAMES[@]}"; do echo "    $t: allow"; done
    } >"$CONFIG_YML"
    echo "Created $CONFIG_YML with tools.approval=allow for: ${TOOL_NAMES[*]}"
  else
    python3 - "$CONFIG_YML" "${TOOL_NAMES[@]}" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
tools = sys.argv[2:]
text = path.read_text()

def ensure_policy(src: str, tool: str) -> str:
    # If the tool already has an approval line, leave it (user may have chosen allow/prompt/deny).
    if re.search(rf"(?m)^\s*{re.escape(tool)}\s*:", src):
        return src
    # Ensure a tools: block exists.
    if re.search(r"(?m)^tools\s*:", src) is None:
        if src and not src.endswith("\n"):
            src += "\n"
        src += "\ntools:\n  approval:\n"
    # Ensure an approval: block exists under tools:.
    elif re.search(r"(?m)^  approval\s*:", src) is None:
        src = re.sub(r"(?m)^(tools\s*:\s*\n)", r"\1  approval:\n", src, count=1)
    # Append the tool line under approval:.
    if re.search(rf"(?m)^\s*{re.escape(tool)}\s*:", src) is None:
        m = re.search(r"(?m)^(  approval\s*:\s*\n)((?:    .*\n)*)", src)
        if m:
            src = src[: m.end(1)] + m.group(2) + f"    {tool}: allow\n" + src[m.end():]
        else:
            if not src.endswith("\n"):
                src += "\n"
            src += f"  approval:\n    {tool}: allow\n"
    return src

orig = text
for t in tools:
    text = ensure_policy(text, t)
if text != orig:
    path.write_text(text)
    print(f"Updated {path} — set missing tools.approval entries to allow for: {', '.join(tools)}")
else:
    print(f"Left {path} unchanged (approval entries already present)")
PY
  fi
fi

echo
echo "Next:"
echo "  1. Credentials for the tools you installed:"
wants x           && echo "       X:            /login → xAI Grok (SuperGrok or X Premium+)  or  export XAI_API_KEY=..."
wants exa         && echo "       Exa:          /login → Exa  or  export EXA_API_KEY=..."
wants parallel    && echo "       Parallel:     /login → Parallel  or  export PARALLEL_API_KEY=..."
wants hackernews  && echo "       Hacker News:  none needed"
wants feed        && echo "       Feeds:        none needed"
wants arxiv       && echo "       arXiv:        none needed"
wants reddit      && echo "       Reddit:       script app at reddit.com/prefs/apps → export REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=..."
wants github      && echo "       GitHub:       works without auth (low rate limit); export GITHUB_TOKEN=... or gh auth login for more"
wants producthunt && echo "       Product Hunt: app at producthunt.com/v2/oauth/applications → export PRODUCTHUNT_API_TOKEN=<Developer Token, not API Key>"
echo "  2. Restart any open omp session so the new tools are discovered."
echo "  3. Ask in chat, e.g.:"
wants x           && echo "       \"what's being said on X about ...\""
wants exa         && echo "       \"use exa for search: ...\""
wants parallel    && echo "       \"use parallel for search: ...\""
wants hackernews  && echo "       \"search hacker news for ...\" / \"what's on the front page of HN?\""
wants feed        && echo "       \"check the ai-labs feeds for ...\""
wants arxiv       && echo "       \"find recent arxiv papers on ...\""
wants reddit      && echo "       \"search reddit for ...\""
wants github      && echo "       \"find new github repos for ...\""
wants producthunt && echo "       \"what launched on product hunt this week?\""
if [[ "$WITH_CONFIRM_RULE" -eq 0 && "$WITH_APPROVAL_GATE" -eq 0 ]]; then
  echo
  echo "Optional: re-run with --with-gate to make the agent propose search settings"
  echo "and wait for your OK before calling these tools."
fi
echo
echo "Docs: docs/x.md, docs/exa.md, docs/parallel.md, docs/hackernews.md, docs/feed.md,"
echo "      docs/arxiv.md, docs/reddit.md, docs/github.md, docs/producthunt.md"
