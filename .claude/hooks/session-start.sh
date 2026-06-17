#!/bin/bash
# -uo pipefail (not -e): every step uses explicit warn-and-continue error handling
# so a provisioning failure never blocks a session (fail-open posture).
set -uo pipefail

# Single source of truth for provisioning Deno in Claude Code's cloud sessions.
# Safe to invoke two ways — point both at this one file:
#   1. the environment Setup script — runs once, before Claude Code launches;
#   2. this SessionStart hook        — runs every session, after setup.
# Each step below is independently guarded, so running it twice is cheap and
# running it once is sufficient.
#
# Local (non-web) machines are skipped entirely: developers manage their own Deno.

warn() { echo "WARNING: gh-project-room/session-start: $*" >&2; }

# Only provision in the remote/web environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"

# Install only when absent — idempotent across the setup script + this hook.
if ! command -v deno &>/dev/null && [ ! -x "$DENO_INSTALL/bin/deno" ]; then
  curl -fsSL https://deno.land/install.sh | sh -s -- --yes \
    || warn "Deno install failed — session continues without Deno on PATH"
fi

# Export onto PATH for the agent's tools. Done UNCONDITIONALLY (not gated on the
# install above), so a session where Deno was pre-installed still gets it on PATH.
# CLAUDE_ENV_FILE is only set in the hook context, so this is a no-op when this
# file runs as the setup script — there, the install above is the contribution.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  if [ ! -e "$CLAUDE_ENV_FILE" ]; then
    warn "\$CLAUDE_ENV_FILE path does not exist — PATH export skipped"
  else
    {
      echo "export DENO_INSTALL=\"$DENO_INSTALL\""
      echo 'export PATH="$DENO_INSTALL/bin:$PATH"'
    } >> "$CLAUDE_ENV_FILE" \
      || warn "could not write to \$CLAUDE_ENV_FILE — PATH export failed"
  fi
fi
