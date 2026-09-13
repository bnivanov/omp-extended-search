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
#   ./install.sh mount-check                diff installed device files against docs/capability-catalog.md
#
# Profile parity (opt-in):
#   --profile               also point ~/.omp/profiles/hermes-jobs/agent/tools at ~/.omp/agent/tools
#                           (symlink-based parity — the link is created/repaired, never copied)
#
# Extras (opt-in, applied on install/update for the selected tools):
#   --with-confirm-rule    also install the deep-research skill (plan lives in the skill, not a rule)
#   --with-approval-gate   also set tools.approval.<tool>: allow in ~/.omp/agent/config.yml
#   --with-gate            both of the above
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.omp/agent/tools"
RULES_DIR="${HOME}/.omp/agent/rules"
SKILLS_DIR="${HOME}/.omp/agent/skills"
CONFIG_YML="${HOME}/.omp/agent/config.yml"

# Canonical short-name order. Keep firecrawl = firecrawl_search; firecrawl-crawl is separate.
ALL_TOOLS=(x x-api exa parallel tavily hackernews feed arxiv reddit github producthunt firecrawl firecrawl-crawl)
# Profile parity: the profile tools dir must be a symlink to the agent tools dir
# (profile-parity.py MIRRORED list includes 'tools' — a real dir there is drift).
PROFILE_NAME="hermes-jobs"
PROFILE_DIR="${HOME}/.omp/profiles/${PROFILE_NAME}/agent/tools"
CATALOG_MD="$ROOT/docs/capability-catalog.md"
WITH_CONFIRM_RULE=0
WITH_APPROVAL_GATE=0
WITH_PROFILE=0
CMD=""
UPDATE_ALL=0
SELECTED=()
# Names that were actually Installed / Updated / Added this run (for the epilogue).
TOUCHED=()

usage() {
  cat <<'EOF'
  ./install.sh install <tool>...|all   install selected tools (or every tool)
  ./install.sh <tool>...|all           legacy form — same as install
  ./install.sh update [tool...]        refresh only tools already present in ~/.omp/agent/tools
  ./install.sh update --all            refresh installed tools and add any missing repo tools
  ./install.sh list                    show every repo tool and whether it is installed / outdated
  ./install.sh mount-check              diff device files in ~/.omp/agent/tools against docs/capability-catalog.md
  ./install.sh -h|--help               show this help

Tools (pick one or more):
  x               x_search.ts            — public posts on X (Twitter) via xAI
  x-api           x_api.ts               — X API v2 recent/archive/lookup/thread/user/timeline/counts
  exa             exa_search.ts          — full Exa search/answer/contents
  parallel        parallel_search.ts     — full Parallel V1 search/extract/task
  hackernews      hackernews_search.ts   — Hacker News search + front-page feeds (no key)
  feed            feed_search.ts         — RSS/Atom reader for blogs/newsletters/news (no key)
  arxiv           arxiv_search.ts        — arXiv paper search (no key)
  reddit          reddit_search.ts       — Reddit via Arctic Shift archive (no key)
  github          github_search.ts       — GitHub repo search, trending/new projects
  producthunt     producthunt_search.ts  — Product Hunt launches (Developer Token, not API Key)
  firecrawl       firecrawl_search.ts    — Firecrawl search + paper/developer indexes (keyless limited; optional FIRECRAWL_API_KEY)
  firecrawl-crawl firecrawl_crawl.ts     — Firecrawl map/scrape/crawl/batch/extract/agent/interact (same credential)
  tavily          tavily_search.ts       — Tavily AI search, extract, map, crawl, and quota (TAVILY_API_KEY)
  all             all of the above (install / update --all)

Extras (opt-in, applied on install/update for the selected tools):
  --with-confirm-rule    install the deep-research skill (visible plan in chat; not an alwaysApply rule)
  --with-approval-gate   set tools.approval.<tool>: allow in config.yml
  --with-gate            both extras

Profile parity (opt-in, valid with install/update/mount-check):
  --profile              ensure ~/.omp/profiles/hermes-jobs/agent/tools is a symlink to
                         ~/.omp/agent/tools (created/repaired if missing/broken — never
                         a copy) and verify device files reach the profile through it

With no arguments this prints the help and installs nothing.
EOF
}

# Explicit short-name → filename map (not every tool is <name>_search.ts).
tool_file() {
  case "$1" in
    x) echo "x_search.ts" ;;
    x-api) echo "x_api.ts" ;;
    exa) echo "exa_search.ts" ;;
    parallel) echo "parallel_search.ts" ;;
    tavily) echo "tavily_search.ts" ;;
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
    x_api.ts) echo "x-api" ;;
    exa_search.ts) echo "exa" ;;
    parallel_search.ts) echo "parallel" ;;
    tavily_search.ts) echo "tavily" ;;
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

# --- profile parity (symlink-based; profile-parity.py MIRRORED includes 'tools') ---

# Read-only report of the profile link state. Used by mount-check (validate only).
check_profile_link() {
  local target
  if [[ -L "$PROFILE_DIR" ]]; then
    if [[ -e "$PROFILE_DIR" ]]; then
      target="$(readlink "$PROFILE_DIR")"
      if [[ "$target" == "$DEST_DIR" ]]; then
        echo "profile link ok: $PROFILE_DIR -> $DEST_DIR"
      else
        echo "profile link MISMATCH: $PROFILE_DIR -> $target (expected $DEST_DIR)"
      fi
    else
      echo "profile link BROKEN: $PROFILE_DIR -> $(readlink "$PROFILE_DIR")"
    fi
  elif [[ -d "$PROFILE_DIR" ]]; then
    echo "profile tools is a REAL DIRECTORY at $PROFILE_DIR — parity must be a symlink to $DEST_DIR (profile-parity flags this as drift)"
  else
    echo "profile link MISSING: $PROFILE_DIR (run 'install.sh --profile install <tool>' or 'install.sh --profile update' to create it)"
  fi
}

# Create/repair the profile tools symlink so profile sessions see the same
# device files as the agent root. Symlink only — never copy (copies drift).
ensure_profile_link() {
  local target f n=0
  if [[ -L "$PROFILE_DIR" && -e "$PROFILE_DIR" ]]; then
    target="$(readlink "$PROFILE_DIR")"
    if [[ "$target" == "$DEST_DIR" ]]; then
      echo "Profile link ok: $PROFILE_DIR -> $DEST_DIR"
    else
      ln -sfn "$DEST_DIR" "$PROFILE_DIR"
      echo "Re-linked profile tools: $PROFILE_DIR -> $DEST_DIR (was -> $target)"
    fi
  elif [[ -L "$PROFILE_DIR" ]]; then
    rm -f "$PROFILE_DIR"
    ln -s "$DEST_DIR" "$PROFILE_DIR"
    echo "Repaired broken profile link: $PROFILE_DIR -> $DEST_DIR"
  elif [[ -d "$PROFILE_DIR" ]]; then
    echo "error: $PROFILE_DIR is a real directory — parity must be a symlink to $DEST_DIR" >&2
    echo "       (profile-parity.py treats a real dir as drift; move it aside and re-run)" >&2
    exit 1
  else
    mkdir -p "$(dirname "$PROFILE_DIR")"
    ln -s "$DEST_DIR" "$PROFILE_DIR"
    echo "Linked profile tools: $PROFILE_DIR -> $DEST_DIR"
  fi
  # Confirm device files reach the profile through the link (not copies).
  for f in "$DEST_DIR"/*.ts; do
    [[ -e "$f" ]] || continue
    n=$((n + 1))
    if [[ ! -f "$PROFILE_DIR/$(basename "$f")" ]]; then
      echo "error: device file did not reach the profile: $(basename "$f")" >&2
      exit 1
    fi
  done
  echo "Profile devices verified: $n file(s) reachable through $PROFILE_DIR"
}

# --- mount verification: device files vs docs/capability-catalog.md ---

cmd_mount_check() {
  local f name tok absent=0 extra=0 mounted_n=0 catalog_n=0
  local mounted=() catalog=()
  if [[ ! -f "$CATALOG_MD" ]]; then
    echo "error: catalog not found: $CATALOG_MD" >&2
    exit 1
  fi

  # Mounted devices: every *.ts device file in the destination dir.
  for f in "$DEST_DIR"/*.ts; do
    [[ -e "$f" ]] || continue
    mounted+=("$(basename "$f" .ts)")
    mounted_n=$((mounted_n + 1))
  done

  # Catalog xd device names: backticked *_search / *_crawl / x_api tokens read
  # from the Tool column (awk field 3 of table rows) — whole-file backtick
  # matching would also catch parameter names like tavily's `safe_search`.
  # (web_search is the native OMP lane, not an xd device.)
  while IFS= read -r tok; do
    case "$tok" in
      web_search) continue ;;
      *_search|*_crawl|x_api) catalog+=("$tok") ;;
    esac
  done < <(awk -F'|' '/^\|/ {print $3}' "$CATALOG_MD" | grep -oE '`[A-Za-z0-9_]+`' | tr -d '`' | sort -u)
  catalog_n="${#catalog[@]}"

  echo "mount-check: device files vs docs/capability-catalog.md"
  echo "  device dir:   $DEST_DIR ($mounted_n device file(s))"
  echo "  catalog rows: $catalog_n xd device name(s)"

  for name in "${catalog[@]+"${catalog[@]}"}"; do
    local found=0 f2
    for f2 in "${mounted[@]+"${mounted[@]}"}"; do
      if [[ "$f2" == "$name" ]]; then
        found=1
        break
      fi
    done
    if [[ "$found" -eq 1 ]]; then
      printf '  ok      %s\n' "$name"
    else
      printf '  absent  %s        (cataloged, no device file — install it, then restart omp)\n' "$name"
      absent=$((absent + 1))
    fi
  done

  for name in "${mounted[@]+"${mounted[@]}"}"; do
    local cataloged=0
    for tok in "${catalog[@]+"${catalog[@]}"}"; do
      if [[ "$tok" == "$name" ]]; then
        cataloged=1
        break
      fi
    done
    if [[ "$cataloged" -eq 0 ]]; then
      printf '  extra   %s        (mounted, not named in the catalog)\n' "$name"
      extra=$((extra + 1))
    fi
  done

  echo "  note: a live session's xd:// mount list may still lag until restart —"
  echo "        this checks device files, not a running session's mounts"
  if [[ $absent -gt 0 || $extra -gt 0 ]]; then
    echo "  drift: $absent absent, $extra extra"
    return 1
  fi
  return 0
}

apply_confirm_rule() {
  # Plan-first gate lives in the skill, not an alwaysApply rule.
  local SKILL_SRC="$ROOT/.agents/skills/deep-research"
  local SKILL_DST="$SKILLS_DIR/deep-research"
  if [[ -d "$SKILL_SRC" ]]; then
    mkdir -p "$SKILLS_DIR"
    rm -rf "$SKILL_DST"
    cp -R "$SKILL_SRC" "$SKILL_DST"
    echo "Installed skill -> ${SKILL_DST}"
  fi
  mkdir -p "$RULES_DIR"
  for stale in omp-search-confirm.md x-search-confirm.md; do
    if [[ -f "$RULES_DIR/$stale" ]]; then
      rm -f "$RULES_DIR/$stale"
      echo "Removed stale rule -> ${RULES_DIR}/${stale} (gate is in the deep-research skill)"
    fi
  done
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
  wants tavily && echo "       Tavily:         export TAVILY_API_KEY=... or session key"
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
  wants tavily && echo "       \"use tavily for search: ...\""
  wants firecrawl && echo "       \"use firecrawl for advanced direct search / papers / developer index: ...\""
  wants firecrawl-crawl && echo "       \"use firecrawl-crawl to map/scrape/crawl/extract ...\""
  wants hackernews && echo "       \"search hacker news for ...\" / \"what's on the front page of HN?\""
  wants feed && echo "       \"check the ai-labs feeds for ...\""
  wants arxiv && echo "       \"find recent arxiv papers on ...\""
  wants reddit && echo "       \"search reddit for ...\""
  wants github && echo "       \"find new github repos for ...\""
  wants producthunt && echo "       \"what launched on product hunt this week?\""
  if [[ "$WITH_CONFIRM_RULE" -eq 0 && "$WITH_APPROVAL_GATE" -eq 0 ]]; then
    echo
    echo "Optional: re-run with --with-gate (or --with-confirm-rule) to install"
    echo "the deep-research skill. The model writes a visible capability plan"
    echo "(chosen vs rejected + cost estimate + how-to-proceed options) in chat"
    echo "and waits. Not an alwaysApply rule; do not use the ask tool."
  fi
  echo
  echo "Docs: docs/capability-catalog.md, docs/x.md, docs/x-api.md, docs/exa.md, docs/parallel.md, docs/tavily.md, docs/hackernews.md, docs/feed.md,"
  echo "      docs/arxiv.md, docs/reddit.md, docs/github.md, docs/producthunt.md, docs/firecrawl.md"
}

# --- argument parsing ---
# Pre-scan: --profile is valid before or after the subcommand.
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --profile) WITH_PROFILE=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
if [[ "${#ARGS[@]}" -eq 0 ]]; then
  if [[ "$WITH_PROFILE" -eq 1 ]]; then
    echo "error: --profile needs a subcommand (install/update/list/mount-check/uninstall)" >&2
    usage >&2
    exit 1
  fi
  usage
  exit 0
fi
set -- "${ARGS[@]}"

# First non-flag token may be a subcommand.
case "${1:-}" in
  install|update|list|uninstall|mount-check)
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
    x|x-api|exa|parallel|tavily|hackernews|feed|arxiv|reddit|github|producthunt|firecrawl|firecrawl-crawl)
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
  mount-check)
    if [[ "${#SELECTED[@]}" -gt 0 || "$UPDATE_ALL" -eq 1 || "$WITH_CONFIRM_RULE" -eq 1 || "$WITH_APPROVAL_GATE" -eq 1 ]]; then
      echo "error: mount-check does not take tool names or extras" >&2
      usage >&2
      exit 1
    fi
    if [[ "$WITH_PROFILE" -eq 1 ]]; then
      check_profile_link
    fi
    cmd_mount_check
    ;;
  list)
    if [[ "${#SELECTED[@]}" -gt 0 || "$UPDATE_ALL" -eq 1 || "$WITH_CONFIRM_RULE" -eq 1 || "$WITH_APPROVAL_GATE" -eq 1 || "$WITH_PROFILE" -eq 1 ]]; then
      echo "error: list does not take tool names, extras, or --profile" >&2
      usage >&2
      exit 1
    fi
    cmd_list
    exit 0
    ;;
  uninstall)
    if [[ "$WITH_CONFIRM_RULE" -eq 1 || "$WITH_APPROVAL_GATE" -eq 1 || "$WITH_PROFILE" -eq 1 ]]; then
      echo "error: extras or --profile are not valid with uninstall" >&2
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
    if [[ "$WITH_PROFILE" -eq 1 ]]; then
      ensure_profile_link
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
    if [[ "$WITH_PROFILE" -eq 1 ]]; then
      ensure_profile_link
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
