#!/usr/bin/env bash
# Install omp-search custom tools (exa_search + parallel_search) into the user omp tools dir.
# Opt-in flags:
#   --with-confirm-rule   install ~/.omp/agent/rules/omp-search-confirm.md (recommend-first UX)
#   --with-approval-gate  set tools.approval.exa_search/parallel_search=prompt in config.yml
#   --with-gate           both of the above (full x_search-style gate)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.omp/agent/tools"
RULES_DIR="${HOME}/.omp/agent/rules"
CONFIG_YML="${HOME}/.omp/agent/config.yml"

WITH_CONFIRM_RULE=0
WITH_APPROVAL_GATE=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--with-confirm-rule] [--with-approval-gate] [--with-gate]

  (default)              Install exa_search.ts + parallel_search.ts only
  --with-confirm-rule    Also install the recommend-first agent rule
  --with-approval-gate   Also set per-tool approval: prompt in config.yml
  --with-gate            Both confirm rule + approval gate (recommended opt-in UX)
EOF
}

for arg in "$@"; do
  case "$arg" in
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
      echo "error: unknown arg: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

mkdir -p "$DEST_DIR"

for f in exa_search.ts parallel_search.ts; do
  if [[ ! -f "$ROOT/$f" ]]; then
    echo "error: $f not found next to this script" >&2
    exit 1
  fi
  cp "$ROOT/$f" "$DEST_DIR/$f"
  echo "Installed $f -> ${DEST_DIR}/$f"
done

if [[ "$WITH_CONFIRM_RULE" -eq 1 ]]; then
  mkdir -p "$RULES_DIR"
  if [[ ! -f "$ROOT/rules/omp-search-confirm.md" ]]; then
    echo "error: rules/omp-search-confirm.md not found next to this script" >&2
    exit 1
  fi
  cp "$ROOT/rules/omp-search-confirm.md" "$RULES_DIR/omp-search-confirm.md"
  echo "Installed rule -> ${RULES_DIR}/omp-search-confirm.md"
fi

if [[ "$WITH_APPROVAL_GATE" -eq 1 ]]; then
  mkdir -p "$(dirname "$CONFIG_YML")"
  if [[ ! -f "$CONFIG_YML" ]]; then
    cat >"$CONFIG_YML" <<'YAML'
tools:
  approval:
    exa_search: prompt
    parallel_search: prompt
YAML
    echo "Created $CONFIG_YML with tools.approval prompt for exa_search + parallel_search"
  else
    python3 - "$CONFIG_YML" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()

def ensure_prompt(src: str, tool: str) -> str:
    # If tool already has an approval line, leave it (user may have chosen allow/deny).
    import re
    if re.search(rf"(?m)^\s*{re.escape(tool)}\s*:", src):
        return src
    # Ensure tools.approval block exists, then append tool line.
    if re.search(r"(?m)^tools\s*:", src) is None:
        if src and not src.endswith("\n"):
            src += "\n"
        src += "\ntools:\n  approval:\n"
    elif re.search(r"(?m)^  approval\s*:", src) is None and re.search(r"(?m)^tools\s*:\n(?:  .*\n)*", src):
        # insert approval under tools:
        src = re.sub(r"(?m)^(tools\s*:\s*\n)", r"\1  approval:\n", src, count=1)
    # Append under approval if missing
    if re.search(rf"(?m)^\s*{re.escape(tool)}\s*:", src) is None:
        # Find approval block and append
        m = re.search(r"(?m)^(  approval\s*:\s*\n)((?:    .*\n)*)", src)
        if m:
            block = m.group(2)
            insertion = f"    {tool}: prompt\n"
            src = src[: m.end(1)] + block + insertion + src[m.end() :]
        else:
            # fallback append
            if not src.endswith("\n"):
                src += "\n"
            src += f"  approval:\n    {tool}: prompt\n"
    return src

orig = text
text = ensure_prompt(text, "exa_search")
text = ensure_prompt(text, "parallel_search")
if text != orig:
    path.write_text(text)
    print(f"Updated {path} — set missing tools.approval.exa_search/parallel_search to prompt")
else:
    print(f"Left {path} unchanged (approval entries already present)")
PY
  fi
fi

echo
echo "Next:"
echo "  1. Credentials:"
echo "       Exa:      export EXA_API_KEY=...   or  /login → Exa"
echo "       Parallel: export PARALLEL_API_KEY=... or  /login → Parallel"
echo "  2. Restart any open omp session so tools/rules are discovered."
echo "  3. In chat:"
echo "       \"use exa for search: …\""
echo "       \"use parallel for search: …\""
echo "       \"use normal web search and expand with Exa and Parallel\""
if [[ "$WITH_CONFIRM_RULE" -eq 0 && "$WITH_APPROVAL_GATE" -eq 0 ]]; then
  echo
  echo "Optional gate (same pattern as omp-x-search), opt-in:"
  echo "  ./install.sh --with-gate"
  echo "  # or separately:"
  echo "  ./install.sh --with-confirm-rule    # model recommends settings first"
  echo "  ./install.sh --with-approval-gate   # hard prompt before tool runs"
else
  echo
  echo "Gate enabled:"
  [[ "$WITH_CONFIRM_RULE" -eq 1 ]] && echo "  • recommend-first rule: ~/.omp/agent/rules/omp-search-confirm.md"
  [[ "$WITH_APPROVAL_GATE" -eq 1 ]] && echo "  • hard approval: tools.approval.exa_search/parallel_search=prompt"
fi
echo
echo "Modes guide: docs/MODES.md"
echo "How this differs from native omp: README.md"
