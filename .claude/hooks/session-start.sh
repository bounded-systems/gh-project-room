#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if ! command -v deno &>/dev/null; then
  curl -fsSL https://deno.land/install.sh | sh -s -- --yes
fi

echo 'export PATH="/root/.deno/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
