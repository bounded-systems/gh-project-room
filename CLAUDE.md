# gh-project-room

GitHub Projects v2 board manager for behavioral prioritization (epic #5).

## What this is

**Front Desk** is the org's single prioritization board. It ingests every open
issue and PR across all org repos, computes a `Score` for each item, and
writes it back so the "Ready (ranked)" view shows the highest-value work at
the top.

## Key files

| File | Purpose |
|------|---------|
| `contract.ts` | Board schema — fields, views, workflows. JSR-exported. |
| `prioritization.ts` | Pure scoring logic — `score()`, `planCapacity()`, `budgetGate()`. JSR-exported. |
| `projects.ts` | GraphQL client for GitHub Projects v2 API. |
| `sync.ts` | Sweep entrypoint — reconcile fields → add items → write scores. |
| `budget-check.ts` | CLI wrapper around `budgetGate()` for CI circuit-breaking. |

## Workflows

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `front-desk-sync.yml` | hourly + `workflow_dispatch` | Full board sweep |
| `front-desk-budget.yml` | `workflow_call` | Budget gate (reusable) |
| `jsr-check.yml` | PRs | `deno fmt`, `deno lint`, `deno check`, JSR dry-run |
| `publish-jsr.yml` | version tags | Publishes to JSR |

## Dogfooding from a Claude Code session

Use the `/sync-board` slash command to dispatch a board sweep without needing
`FRONT_DESK_TOKEN` locally. The sweep runs in GitHub Actions and reads
`FRONT_DESK_TOKEN` from the org secret.

## Development

Runtime: **Deno v2**. No `npm install` needed.

```sh
# type-check
deno check contract.ts prioritization.ts schema.ts

# format
deno fmt

# lint
deno lint

# run sweep locally (requires GITHUB_TOKEN in env)
GITHUB_TOKEN=... deno run --allow-net=api.github.com --allow-env sync.ts
```

## Required secret

`FRONT_DESK_TOKEN` — org-level secret with:
- `organization projects: read + write` (Projects v2 mutations)
- `issues: read` (all org repos)
- `metadata: read` (repo enumeration)

A GitHub App installation token is recommended over a PAT.
