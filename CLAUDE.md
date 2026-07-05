# gh-project-room

GitHub Projects v2 board manager for behavioral prioritization (epic #5).

## What this is

**Front Desk** is the org's single prioritization board. It ingests every open
issue and PR across all org repos, computes a `Score` for each item, and writes
it back so the "Ready (ranked)" view shows the highest-value work at the top.

## Key files

| File                | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `contract.ts`       | Board schema — fields, views, workflows. JSR-exported.                          |
| `prioritization.ts` | Pure scoring logic — `score()`, `planCapacity()`, `budgetGate()`. JSR-exported. |
| `projects.ts`       | GraphQL client for GitHub Projects v2 API.                                      |
| `sync.ts`           | Sweep entrypoint — reconcile fields → add items → write scores.                 |
| `budget-check.ts`   | CLI wrapper around `budgetGate()` for CI circuit-breaking.                      |
| `health.ts`         | Charter self-check — `healthReport()` (pure) + CLI. One row per invariant.      |
| `health-issue.ts`   | Auto-file/update/close the health tracking issue when a gate is red (#64).      |

## Workflows

| Workflow                | Trigger                                    | What it does                                       |
| ----------------------- | ------------------------------------------ | -------------------------------------------------- |
| `front-desk-sync.yml`   | weekly + repo events + `workflow_dispatch` | Full board sweep                                   |
| `front-desk-budget.yml` | `workflow_call`                            | Budget gate (reusable)                             |
| `jsr-check.yml`         | PRs                                        | `deno fmt`, `deno lint`, `deno check`, JSR dry-run |
| `publish-jsr.yml`       | version tags                               | Publishes to JSR                                   |

## Dogfooding from a Claude Code session

Use the `/sync-board` slash command to dispatch a board sweep without needing
any local token. The sweep runs in GitHub Actions, which mints the Front Desk
App's installation token over OIDC via the org's `cf-token-broker` (see
`front-desk-sync.yml`'s comments) — this is the production path and should be
preferred over a local run for anything that **writes** (`sync.ts`,
`health-issue.ts`). The App's private key lives only in the broker; there is no
`FRONT_DESK_TOKEN`/`FRONT_DESK_APP_PRIVATE_KEY` org secret to read locally
(retired when the broker replaced the old `create-github-app-token` fallback).

## Development

Runtime: **Deno v2**. No `npm install` needed.

```sh
# type-check
deno check contract.ts prioritization.ts schema.ts

# format
deno fmt

# lint
deno lint

# unit tests (no token needed — the pure cores are network-free)
deno task test
```

Anything below that hits the GitHub API needs `GITHUB_TOKEN` set to a token with
the Front Desk App's org-wide reach (issues/PRs across every repo, the Project
v2 board) — a personal token (e.g. `gh auth token`) only works for read-only
checks, and should not be used for anything that writes on your behalf:

```sh
# read-only — a personal token is fine
GITHUB_TOKEN=... deno task health

# writes (adds items, sets Score, files/closes issues) — prefer dispatching via
# GitHub Actions (/sync-board) so the Front Desk App is the one making the
# request, not your personal token
GITHUB_TOKEN=... deno run --allow-net=api.github.com --allow-env sync.ts
GITHUB_TOKEN=... deno task health-issue
```

## Secrets & tokens

| Where                                            | What                                                  | Notes                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| org variable `FRONT_DESK_BROKER_URL`             | `cf-token-broker` base URL (not a secret)             | read by `front-desk-sync.yml`, `front-desk-health.yml`, `front-desk-add.yml` to mint the App token over OIDC                             |
| Cloudflare Worker secrets (`front-desk-webhook`) | `GITHUB_WEBHOOK_SECRET`, `FRONT_DESK_APP_PRIVATE_KEY` | held only in the Worker (`wrangler secret put`), never in this repo or org secrets — see `infra/cloudflare/front-desk-webhook/deploy.sh` |

Verified 2026-07-05: the only org-level secret is `CLOUDFLARE_API_TOKEN`
(unrelated, Worker deploy) — no
`FRONT_DESK_APP_CLIENT_ID`/`FRONT_DESK_APP_PRIVATE_KEY` org secrets exist. The
App's actual installed grant: `organization_projects: admin`, `issues: write`,
`contents: write`, `pull_requests: write`, `actions: read`, `workflows: write`,
`metadata: read`. `issues: write` is what lets `health-issue.ts` (#64)
file/update/close the tracking issue.
