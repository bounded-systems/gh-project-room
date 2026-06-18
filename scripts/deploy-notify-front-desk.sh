#!/usr/bin/env bash
# Deploy notify-front-desk.yml to all public org repos.
# Repos with branch-protection rules (require PR + signed commits) will be
# skipped with an error — handle those manually via PR.
#
# Usage: ./scripts/deploy-notify-front-desk.sh
set -euo pipefail
export GH_PAGER=cat

WORKFLOW='name: notify-front-desk
on:
  issues:
    types: [opened, closed, reopened, labeled, unlabeled]
  pull_request:
    types: [opened, closed, reopened, labeled, unlabeled]
jobs:
  sync:
    uses: bounded-systems/gh-project-room/.github/workflows/trigger-sync.yml@main
    secrets: inherit
'

# Public repos to wire up (skip gh-project-room — already has native triggers;
# skip private repos — org secrets unavailable on free plan).
REPOS=(
  prx
  claude-box
  ocap-provenance
  guest-room
  door-kit
  door-concierge
  door-keeper
  door-scout
  door-net
  door-peercred
  claude-token-tools
  facilities
)

CONTENT=$(printf '%s' "$WORKFLOW" | base64 -w0 2>/dev/null || printf '%s' "$WORKFLOW" | base64)

for repo in "${REPOS[@]}"; do
  # Get current SHA if file already exists (required for updates).
  existing_sha=$(gh api \
    "/repos/bounded-systems/$repo/contents/.github/workflows/notify-front-desk.yml" \
    --jq '.sha' 2>/dev/null || true)

  args=(
    --method PUT
    -H "Accept: application/vnd.github+json"
    "/repos/bounded-systems/$repo/contents/.github/workflows/notify-front-desk.yml"
    --field "message=feat: notify Front Desk on issue/PR events"
    --field "content=$CONTENT"
  )
  if [[ -n "$existing_sha" ]]; then
    args+=(--field "sha=$existing_sha")
  fi

  if gh api "${args[@]}" > /dev/null; then
    echo "✓ $repo"
  else
    echo "✗ $repo (skipped — may require PR)"
  fi
done
