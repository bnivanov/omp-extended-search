#!/usr/bin/env bash
# Install omp-search custom tools (exa_search + parallel_search) into the user omp tools dir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.omp/agent/tools"

mkdir -p "$DEST_DIR"

for f in exa_search.ts parallel_search.ts; do
  if [[ ! -f "$ROOT/$f" ]]; then
    echo "error: $f not found next to this script" >&2
    exit 1
  fi
  cp "$ROOT/$f" "$DEST_DIR/$f"
  echo "Installed $f -> ${DEST_DIR}/$f"
done

echo
echo "Next:"
echo "  1. Credentials:"
echo "       Exa:      export EXA_API_KEY=...   or  /login → Exa"
echo "       Parallel: export PARALLEL_API_KEY=... or  /login → Parallel"
echo "  2. Restart any open omp session so tools are discovered."
echo "  3. In chat:"
echo "       \"use exa for search: …\""
echo "       \"use parallel for search: …\""
echo "       \"use normal web search and expand with Exa and Parallel\""
echo
echo "Modes guide: docs/MODES.md"
echo "How this differs from native omp: README.md"
