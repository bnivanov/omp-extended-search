#!/usr/bin/env bash
# Install omp-extended-search tools into ~/.omp/agent/tools.
# You pick which tools to install; bare invocation prints help and installs nothing.
#
#   ./install.sh install x                  install x_search only
#   ./install.sh exa parallel               legacy form — same as install
#   ./install.sh update                     refresh only what is already installed
#   ./install.sh update --all               converge destination to the full repo set
#   ./install.sh list                       show install status for every repo tool
#   ./install.sh uninstall arxiv            remove a previously installed tool
#
# Opt-in extras (applied on install/update for the selected tools):
#   --with-confirm-rule    also install the recommend-first agent rule(s) into ~/.omp/agent/rules
#   --with-approval-gate   also set tools.approval.<tool>: allow in ~/.omp/agent/config.yml
#   --with-gate            both of the above
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.omp/agent/tools"
RULES_DIR="${HOME}/.omp/agent/rules"
CONFIG_YML="${HOME}/.omp/agent/config.yml"

# Canonical short-name order. Keep firecrawl = firecrawl_search; firecrawl-crawl is separate.
ALL_TOOLS=(x exa parallel hackernews feed arxiv reddit github producthunt firecrawl firecrawl-crawl)

WITH_CONFIRM_RULE=0
WITH_APPROVAL_GATE=0
CMD=""
UPDATE_ALL=0
SELECTED=()
# Names that were actually Installed / Updated / Added this run (for the epilogue).
TOUCHED=()

usage() {
  cat <<'EOF'
Usage:
  ./install.sh install <tool>...|all   install selected tools (or every tool)
  ./install.sh <tool>...|all           legacy form — same as install
  ./install.sh update [tool...]        refresh only tools already present in ~/.omp/agent/tools
  ./install.sh update --all            refresh installed tools and add any missing repo tools
  ./install.sh list                    show every repo tool and whether it is installed / outdated
  ./install.sh uninstall <tool>...     remove named tool files from the destination
  ./install.sh -h|--help               show this help

Tools (pick one or more):
  x               x_search.ts            — public posts on X (Twitter) via xAI
  exa             exa_search.ts          — full Exa search/answer/contents
  parallel        parallel_search.ts     — full Parallel V1 search/extract/task
  hackernews      hackernews_search.ts   — Hacker News search + front-page feeds (no key)
  feed            feed_search.ts         — RSS/Atom reader for blogs/newsletters/news (no key)
  arxiv           arxiv_search.ts        — arXiv paper search (no key)
  reddit          reddit_search.ts       — Reddit via Arctic Shift archive (no key)
  github          github_search.ts       — GitHub repo search, trending/new projects
  producthunt     producthunt_search.ts  — Product Hunt launches (Developer Token, not API Key)
  firecrawl       firecrawl_search.ts    — advanced direct Firecrawl search (keyless limited; optional FIRECRAWL_API_KEY)
  firecrawl-crawl firecrawl_crawl.ts     — Firecrawl crawl/map (same Firecrawl credential as firecrawl)
  all             all of the above (install / update --all)

Extras (opt-in, applied on install/update for the selected tools):
  --with-confirm-rule    install the global plan-first agent rule (all search tools)
  --with-approval-gate   set tools.approval.<tool>: allow in config.yml
  --with-gate            both extras

With no arguments this prints the help and installs nothing.
EOF
}

# Explicit short-name → filename map (not every tool is <name>_search.ts).
tool_file() {
  case "$1" in
    x) echo "x_search.ts" ;;
    exa) echo "exa_search.ts" ;;
    parallel) echo "parallel_search.ts" ;;
    hackernews) echo "hackernews_search.ts" ;;
    feed) echo "feed_search.ts" ;;
    arxiv) echo "arxiv_search.ts" ;;
    reddit) echo "reddit_search.ts" ;;
    github) echo "github_search.ts" ;;
    producthunt) echo "producthunt_search.ts" ;;
    firecrawl) echo "firecrawl_search.ts" ;;
    firecrawl-crawl) echo "firecrawl_crawl.ts" ;;
    *)
      echo "error: unknown tool: $1" >&2
      return 1
      ;;
  esac
}

# Filename → short name (for scanning the destination directory).
name_for_file() {
  case "$1" in
    x_search.ts) echo "x" ;;
    exa_search.ts) echo "exa" ;;
    parallel_search.ts) echo "parallel" ;;
    hackernews_search.ts) echo "hackernews" ;;
    feed_search.ts) echo "feed" ;;
    arxiv_search.ts) echo "arxiv" ;;
    reddit_search.ts) echo "reddit" ;;
    github_search.ts) echo "github" ;;
    producthunt_search.ts) echo "producthunt" ;;
    firecrawl_search.ts) echo "firecrawl" ;;
    firecrawl_crawl.ts) echo "firecrawl-crawl" ;;
    *) return 1 ;;
  esac
}

# xd:// / tools.approval name = filename without .ts
tool_xd_name() {
  local f
  f="$(tool_file "$1")" || return 1
  echo "${f%.ts}"
}

is_known_tool() {
  local t
  for t in "${ALL_TOOLS[@]}"; do
    [[ "$t" == "$1" ]] && return 0
  done
  return 1
}

dedupe_selected() {
  local UNIQUE=() s u seen
  if [[ "${#SELECTED[@]}" -eq 0 ]]; then
    return 0
  fi
  for s in "${SELECTED[@]}"; do
    [[ -z "$s" ]] && continue
    seen=0
    for u in "${UNIQUE[@]+"${UNIQUE[@]}"}"; do
      [[ "$u" == "$s" ]] && seen=1 && break
    done
    [[ "$seen" -eq 0 ]] && UNIQUE+=("$s")
  done
  SELECTED=()
  if [[ "${#UNIQUE[@]}" -gt 0 ]]; then
    SELECTED=("${UNIQUE[@]}")
  fi
}

wants() {
  local needle="$1" s
  for s in "${TOUCHED[@]+"${TOUCHED[@]}"}"; do
    [[ "$s" == "$needle" ]] && return 0
  done
  return 1
}

mark_touched() {
  local s="$1" u seen=0
  for u in "${TOUCHED[@]+"${TOUCHED[@]}"}"; do
    [[ "$u" == "$s" ]] && seen=1 && break
  done
  [[ "$seen" -eq 0 ]] && TOUCHED+=("$s")
}

dest_path() {
  local f
  f="$(tool_file "$1")" || return 1
  echo "$DEST_DIR/$f"
}

repo_path() {
  local f
  f="$(tool_file "$1")" || return 1
  echo "$ROOT/tools/$f"
}

# Copy one tool. verb_new = Installed|Added (when dest missing).
# Prints Installed|Updated|Added|Unchanged and marks TOUCHED on real change or presence intent.
copy_tool() {
  local name="$1"
  local verb_new="${2:-Installed}"
  local src dst
  src="$(repo_path "$name")"
  dst="$(dest_path "$name")"

  if [[ ! -f "$src" ]]; then
    echo "error: tools/$(tool_file "$name") not found in this repo" >&2
    exit 1
  fi

  if [[ -f "$dst" ]]; then
    if cmp -s "$src" "$dst"; then
      echo "Unchanged tools/$(tool_file "$name") -> $dst"
      mark_touched "$name"
      return 0
    fi
    cp "$src" "$dst"
    echo "Updated tools/$(tool_file "$name") -> $dst"
    mark_touched "$name"
    return 0
  fi

  mkdir -p "$DEST_DIR"
  cp "$src" "$dst"
  echo "${verb_new} tools/$(tool_file "$name") -> $dst"
  mark_touched "$name"
}

# --- installed-set discovery (match dest filenames against known repo tools) ---
installed_tools() {
  local f name
  local found=()
  if [[ ! -d "$DEST_DIR" ]]; then
    return 0
  fi
  # Stable order: walk ALL_TOOLS, keep those present.
  for name in "${ALL_TOOLS[@]}"; do
    f="$(tool_file "$name")"
    if [[ -f "$DEST_DIR/$f" ]]; then
      found+=("$name")
    fi
  done
  if [[ "${#found[@]}" -gt 0 ]]; then
    printf '%s\n' "${found[@]}"
  fi
}

cmd_list() {
  local name f src dst status
  printf '%-16s %-24s %s\n' "TOOL" "FILE" "STATUS"
  printf '%-16s %-24s %s\n' "----" "----" "------"
  for name in "${ALL_TOOLS[@]}"; do
    f="$(tool_file "$name")"
    src="$ROOT/tools/$f"
    dst="$DEST_DIR/$f"
    if [[ ! -f "$dst" ]]; then
      status="not installed"
    elif [[ -f "$src" ]] && cmp -s "$src" "$dst"; then
      status="installed (up to date)"
    else
      status="installed (outdated)"
    fi
    printf '%-16s %-24s %s\n' "$name" "$f" "$status"
  done
}

cmd_uninstall() {
  local name f dst any=0
  if [[ "${#SELECTED[@]}" -eq 0 ]]; then
    echo "error: uninstall requires at least one tool name" >&2
    usage >&2
    exit 1
  fi
  for name in "${SELECTED[@]}"; do
    f="$(tool_file "$name")"
    dst="$DEST_DIR/$f"
    if [[ ! -f "$dst" ]]; then
      echo "error: $name is not installed ($dst)" >&2
      exit 1
    fi
    rm -f "$dst"
    echo "Uninstalled $f from $DEST_DIR"
    any=1
  done
  [[ "$any" -eq 1 ]]
}

cmd_install() {
  local name
  if [[ "${#SELECTED[@]}" -eq 0 ]]; then
    echo "error: install requires at least one tool name or 'all'" >&2
    usage >&2
    exit 1
  fi
  mkdir -p "$DEST_DIR"
  for name in "${SELECTED[@]}"; do
    copy_tool "$name" "Installed"
  done
}

cmd_update() {
  local name f installed=()
  if [[ "$UPDATE_ALL" -eq 1 ]]; then
    # Converge to full repo set: update present, add missing.
    mkdir -p "$DEST_DIR"
    for name in "${ALL_TOOLS[@]}"; do
      f="$(tool_file "$name")"
      if [[ -f "$DEST_DIR/$f" ]]; then
        copy_tool "$name" "Updated"
      else
        copy_tool "$name" "Added"
      fi
    done
    return 0
  fi

  if [[ "${#SELECTED[@]}" -gt 0 ]]; then
    for name in "${SELECTED[@]}"; do
      f="$(tool_file "$name")"
      if [[ ! -f "$DEST_DIR/$f" ]]; then
        echo "error: $name is not installed — use 'install $name' to add it" >&2
        exit 1
      fi
      copy_tool "$name" "Updated"
    done
    return 0
  fi

  # No args: refresh only what is already installed.
  for name in "${ALL_TOOLS[@]}"; do
    f="$(tool_file "$name")"
    if [[ -f "$DEST_DIR/$f" ]]; then
      installed+=("$name")
    fi
  done

  if [[ "${#installed[@]}" -eq 0 ]]; then
    echo "nothing installed yet — use 'install <tool>...' or 'install all' to add tools"
    exit 0
  fi

  for name in "${installed[@]}"; do
    copy_tool "$name" "Updated"
  done
}

apply_confirm_rule() {
  mkdir -p "$RULES_DIR"
  # One global plan-first gate: web_search + every extended tool (including X).
  cp "$ROOT/rules/omp-search-confirm.md" "$RULES_DIR/omp-search-confirm.md"
  echo "Installed rule -> ${RULES_DIR}/omp-search-confirm.md"
  # Drop legacy X-only rule if a previous install left it behind.
  if [[ -f "$RULES_DIR/x-search-confirm.md" ]]; then
    rm -f "$RULES_DIR/x-search-confirm.md"
    echo "Removed legacy rule -> ${RULES_DIR}/x-search-confirm.md (folded into omp-search-confirm)"
  fi
}

apply_approval_gate() {
  local TOOL_NAMES=() s xd
  mkdir -p "$(dirname "$CONFIG_YML")"
  for s in "${TOUCHED[@]+"${TOUCHED[@]}"}"; do
    xd="$(tool_xd_name "$s")"
    TOOL_NAMES+=("$xd")
  done
  if [[ "${#TOOL_NAMES[@]}" -eq 0 ]]; then
    return 0
  fi
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
}

print_epilogue() {
  local action_label="$1"
  local any_firecrawl=0

  if [[ "${#TOUCHED[@]}" -eq 0 ]]; then
    return 0
  fi

  echo
  echo "Next:"
  echo "  1. Credentials for the tools you ${action_label}:"
  wants x && echo "       X:              /login → xAI Grok (SuperGrok or X Premium+)  or  export XAI_API_KEY=..."
  wants exa && echo "       Exa:            /login → Exa  or  export EXA_API_KEY=..."
  wants parallel && echo "       Parallel:       /login → Parallel  or  export PARALLEL_API_KEY=..."
  if wants firecrawl || wants firecrawl-crawl; then
    any_firecrawl=1
  fi
  if [[ "$any_firecrawl" -eq 1 ]]; then
    echo "       Firecrawl:      keyless limited mode; export FIRECRAWL_API_KEY=... for higher limits"
    wants firecrawl-crawl && echo "                       (covers firecrawl + firecrawl-crawl)"
  fi
  wants hackernews && echo "       Hacker News:    none needed"
  wants feed && echo "       Feeds:          none needed"
  wants arxiv && echo "       arXiv:          none needed"
  wants reddit && echo "       Reddit:         none needed (Arctic Shift archive; not the official API)"
  wants github && echo "       GitHub:         works without auth (low rate limit); export GITHUB_TOKEN=... or gh auth login for more"
  wants producthunt && echo "       Product Hunt:   app at producthunt.com/v2/oauth/applications → export PRODUCTHUNT_API_TOKEN=<Developer Token, not API Key>"
  echo "  2. Restart any open omp session so the tools are discovered under xd://."
  echo "     Sanity check: read xd://<tool> (e.g. xd://hackernews_search or xd://firecrawl_crawl) → schema."
  echo "     Invoke:       write JSON args to that same xd:// path (NOT xdi://, NOT a bare file)."
  echo "  3. Ask in chat, e.g.:"
  wants x && echo "       \"what's being said on X about ...\""
  wants exa && echo "       \"use exa for search: ...\""
  wants parallel && echo "       \"use parallel for search: ...\""
  wants firecrawl && echo "       \"use firecrawl for advanced direct search: ...\""
  wants firecrawl-crawl && echo "       \"use firecrawl-crawl to crawl/map ...\""
  wants hackernews && echo "       \"search hacker news for ...\" / \"what's on the front page of HN?\""
  wants feed && echo "       \"check the ai-labs feeds for ...\""
  wants arxiv && echo "       \"find recent arxiv papers on ...\""
  wants reddit && echo "       \"search reddit for ...\""
  wants github && echo "       \"find new github repos for ...\""
  wants producthunt && echo "       \"what launched on product hunt this week?\""
  if [[ "$WITH_CONFIRM_RULE" -eq 0 && "$WITH_APPROVAL_GATE" -eq 0 ]]; then
    echo
    echo "Optional: re-run with --with-gate (or --with-confirm-rule) so the agent"
    echo "proposes which sources + settings to use and waits for your OK in chat."
    echo "One global rule covers web_search and every extended tool (including X)."
  fi
  echo
  echo "Docs: docs/x.md, docs/exa.md, docs/parallel.md, docs/hackernews.md, docs/feed.md,"
  echo "      docs/arxiv.md, docs/reddit.md, docs/github.md, docs/producthunt.md, docs/firecrawl.md"
}

# --- argument parsing ---
if [[ "$#" -eq 0 ]]; then
  usage
  exit 0
fi

# First non-flag token may be a subcommand.
case "${1:-}" in
  install|update|list|uninstall)
    CMD="$1"
    shift
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    # Legacy flat form: tools/flags only → install
    CMD="install"
    ;;
esac

while [[ "$#" -gt 0 ]]; do
  arg="$1"
  shift
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    --with-confirm-rule) WITH_CONFIRM_RULE=1 ;;
    --with-approval-gate) WITH_APPROVAL_GATE=1 ;;
    --with-gate)
      WITH_CONFIRM_RULE=1
      WITH_APPROVAL_GATE=1
      ;;
    --all)
      if [[ "$CMD" != "update" ]]; then
        echo "error: --all is only valid with 'update'" >&2
        usage >&2
        exit 1
      fi
      UPDATE_ALL=1
      ;;
    all)
      if [[ "$CMD" == "uninstall" ]]; then
        echo "error: 'all' is not valid with uninstall — name tools explicitly" >&2
        exit 1
      fi
      if [[ "$CMD" == "update" ]]; then
        # bare 'all' on update is treated like --all (converge)
        UPDATE_ALL=1
      else
        SELECTED=("${ALL_TOOLS[@]}")
      fi
      ;;
    x|exa|parallel|hackernews|feed|arxiv|reddit|github|producthunt|firecrawl|firecrawl-crawl)
      SELECTED+=("$arg")
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

dedupe_selected

case "$CMD" in
  list)
    if [[ "${#SELECTED[@]}" -gt 0 || "$UPDATE_ALL" -eq 1 || "$WITH_CONFIRM_RULE" -eq 1 || "$WITH_APPROVAL_GATE" -eq 1 ]]; then
      echo "error: list does not take tool names or extras" >&2
      usage >&2
      exit 1
    fi
    cmd_list
    exit 0
    ;;
  uninstall)
    if [[ "$WITH_CONFIRM_RULE" -eq 1 || "$WITH_APPROVAL_GATE" -eq 1 ]]; then
      echo "error: extras are not valid with uninstall" >&2
      exit 1
    fi
    cmd_uninstall
    exit 0
    ;;
  install)
    cmd_install
    if [[ "$WITH_CONFIRM_RULE" -eq 1 ]]; then
      apply_confirm_rule
    fi
    if [[ "$WITH_APPROVAL_GATE" -eq 1 ]]; then
      apply_approval_gate
    fi
    print_epilogue "installed"
    ;;
  update)
    cmd_update
    if [[ "$WITH_CONFIRM_RULE" -eq 1 ]]; then
      apply_confirm_rule
    fi
    if [[ "$WITH_APPROVAL_GATE" -eq 1 ]]; then
      apply_approval_gate
    fi
    if [[ "$UPDATE_ALL" -eq 1 ]]; then
      print_epilogue "updated/added"
    else
      print_epilogue "updated"
    fi
    ;;
  *)
    echo "error: unknown command: $CMD" >&2
    usage >&2
    exit 1
    ;;
esac
