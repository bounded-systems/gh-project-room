#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if command -v deno &>/dev/null; then
  exit 0
fi

curl -fsSL https://deno.land/install.sh | sh -s -- --yes
echo 'export DENO_INSTALL="/root/.deno"' >> "$CLAUDE_ENV_FILE"
echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
