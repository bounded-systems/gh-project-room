# Front Desk — Charter

> Governance spec for the bounded-systems roadmap. It lives here, next to the
> mechanisms that enforce it (`webhook.ts`, `contract.ts`, `sync.ts`).

## Purpose

**Front Desk (org GitHub Project #2) is the single roadmap for bounded-systems,
and it drives all decisions.** Every unit of intent and delivery across every
repo surfaces here.

Hotel framing (see `contract.ts`): every _guest_ (an issue or PR) checks in at
one front desk, no matter which _room_ (repo) it belongs to. If it isn't on
Front Desk, it isn't real work.

## Model

- **Issue = a unit of intent** — a roadmap item. Carries
  `Kind ∈ {epic, room,
  door, task}`.
- **PR = a unit of delivery.**
- **Intent ↔ delivery is one-to-one:** every merged PR closes exactly one issue.

This is the enforceable form of the existing PR standard ("ship minimal,
independent PRs; avoid bundled changes"). One PR = one issue = one intent.

## Invariants

### 1. Coverage

Every open issue/PR in every public repo appears on Front Desk.

- **Mechanism:** the instant `front-desk-webhook` Worker (opened/reopened) plus
  the daily sweep (`sync.ts`) as backstop.
- **Status:** proven — 73/73 public repos verified landing live (2026-07-04).

### 2. Traceability

Every merged PR closes exactly one issue.

| `closingIssuesReferences.totalCount` | Meaning           | Action                                  |
| ------------------------------------ | ----------------- | --------------------------------------- |
| 0                                    | Off-roadmap work  | **Report** (coverage gap), do not block |
| 1                                    | Ideal             | —                                       |
| ≥2                                   | Conflated intents | **Block** — split the PR                |

- Signal source: GitHub GraphQL `pullRequest.closingIssuesReferences.totalCount`
  (hard, queryable — no heuristics).
- The **≥2 rule is absolute** — no exemptions.
- The **0 rule is a report, not a gate** — visibility, not friction — and honors
  the exemption contract below.

### 3. Contract-first schema changes

The board's schema (fields, options, views) is only ever changed **through
`contract.ts`** — never by editing the live board directly. The room's sweep
reconciles the live board _toward_ the contract, so the reconciler always wins
against an out-of-band edit; a direct change is undone on the next sweep.

- **Rule:** to add/remove/rename a field or view, change `contract.ts` and merge
  it first, then let the sweep apply it. Deleting a field on the live board
  without removing it from the contract causes drift ping-pong — a sweep from
  stale `main` re-creates it (observed 2026-07-25, when the org-only date fields
  were deleted to allow public visibility mid-PR; fixed by merging the contract
  change #81 first).
- **Mechanism (to build, #83):** the sweep should record the contract commit it
  was built from and re-check at apply time that `main` hasn't advanced past it
  (a compare-and-swap at the reconcile boundary — the same stale-read hazard the
  `front-desk-scheduler` model proves for the scheduler). Until then this is a
  process rule enforced by review.

## Exemption contract

Declared config, not ad-hoc judgement. Exempt PR classes are omitted from the
0-closing-issue **report** (they never need a closing issue). The ≥2 block is
never exempt.

```yaml
# front-desk exemptions — PR classes that need no closing issue.
# Global default; a repo may extend its own list.
exempt_from_closing_issue:
  - release_publish_prs # automated version-bump / release PRs (e.g. mint)
  - automated_dependency_prs # dependabot / renovate dependency bumps
```

> **Future direction:** rather than exempting automation PRs, have the
> automation _auto-create a tracking issue_ so even release/dependency work
> carries a roadmap trace. Exemption is the interim; auto-issue is the target.

For now this contract lives in this doc. When enforcement is built it graduates
to a machine-readable config the check reads (global + per-repo override).

## Cadence

- **Instant (webhook):** adds items + sets `Kind`. Live.
- **Periodic (daily sweep):** reconciles `Status`, recomputes `Score`,
  reconciles field-schema drift against `contract.ts`.

### Known gap — the webhook does not set Status

`webhook.ts` only _adds_ items (opened/reopened issue, opened PR) and sets
`Kind`. Close/reopen actions are ignored. So today the **only** thing that moves
a closed issue to `Done` — and that sets `Status` at all — is the sweep.

**Consequence:** you cannot go webhook-only today without `Status` going stale
(closed issues linger as `Todo` on the roadmap). For a board that drives
decisions, stale `Status` is worse than stale `Score`.

### Target sequencing (toward webhook-mostly)

1. Extend `webhook.ts` to handle `closed`/`reopened` → set `Status` (the App is
   already subscribed to these events; the payloads arrive, the code ignores
   them — no re-subscription needed).
2. **Then** reduce the cron daily → weekly. `Score` recompute + schema-drift
   reconcile are the only genuinely periodic jobs; neither needs daily
   freshness.
3. Do **not** cut the cron before step 1 — it would silently break `Status`.

## Roadmap (future work)

- **Intent-vs-actual:** verify a merged PR's delivery matched the _closed
  issue's stated acceptance criteria_ — did what the ticket asked for match what
  happened? Semantic check, beyond the structural one-to-one link.
- **Auto-create issues** for exempted automation PRs (see exemption contract).
- **Webhook-mostly:** after Status-on-close lands, sweep → weekly or on-demand.
- **Private board:** private repos feed a separate private board (the public
  receiver already fail-closed-skips them).

## Enforcement mechanisms (to build)

- **≥2 blocker:** a reusable CI check (PR status) that fails when
  `closingIssuesReferences.totalCount > 1`.
- **0-issue report:** a periodic scan of merged PRs → coverage report / Front
  Desk annotation, honoring the exemption contract.
