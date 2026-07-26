# Behavioral prioritization — delivered (epic #5)

> Closes the epic: Front Desk is no longer a passive board. It is a callable,
> budget-gated function that an agent consults to decide _what to do next_, _for
> how much effort_, and _whether it's allowed to spend more right now_ — and the
> function's own API consumption is metered and gated by the same contract.
> Delivered 2026-07-25.

## The checklist, as landed

| Epic item                                                                          | Delivery                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Effort` + `Value` fields (the root: "the prioritizer is a function with no data") | Fields exist **and are populated**: 1,253/1,253 board items carry Effort/Value (heuristic estimator; agent estimation drops in behind the same seam). The ranked queue is value-density (WSJF-style), not near-FIFO fallback.                                                     |
| `Score` writeback + ranked Ready view                                              | Live (sweep) — now computing over real inputs.                                                                                                                                                                                                                                    |
| Org standard Budgets (rolling 5h + weekly)                                         | `prioritization.ts` (`ROLLING_5H_BUDGET`, `WEEKLY_BUDGET`, `ORG_BUDGETS`).                                                                                                                                                                                                        |
| `budget-check.ts` + `front-desk-budget` workflow                                   | In this repo.                                                                                                                                                                                                                                                                     |
| Window-burn metering (`consumedPoints` per window)                                 | Delivered reflexively: the GitHub GraphQL rate limit is modeled as a `Budget` (5000 pts / rolling 1h); every board pull's **actual** cost is measured (1,314 pts for a full pull) and recorded to an `api_spend` table; syncs and bulk writes fail closed through `budgetGate()`. |
| Capacity Insights chart                                                            | Contract (`FRONT_DESK_INSIGHTS`).                                                                                                                                                                                                                                                 |

## What grew around the epic

- **The Concierge interaction** — `whats-next`: reads the board, returns the
  ranked eligible queue + a budget verdict (allow/deny with reason).
  [bounded-systems/front-desk-scheduler](https://github.com/bounded-systems/front-desk-scheduler).
- **A formally verified scheduler under it.** The concurrent mechanism around
  `prioritize()`/`budgetGate()` (claim/spend/complete) is modeled and checked at
  four altitudes — deterministic simulation (seed-replayable races), TLA+ (racy
  config yields the double-claim/overspend counterexamples; atomic config passes
  safety + liveness), Lean 4 (`budgetGate` soundness proven; the TOCTOU proven
  unsound), and Rust/loom (real-atomics interleavings). Same S2 overspend bug
  demonstrated in all four.
- **A CQRS read plane.**
  [bounded-systems/front-desk-mirror on DoltHub](https://www.dolthub.com/repositories/bounded-systems/front-desk-mirror):
  a versioned Dolt mirror synced every 6h by a deployed worker
  (`mirror-sync.yml`) that mints the Front Desk App token over OIDC via the
  org's `cf-token-broker`. Consumers query board state over HTTPS at a pinned
  commit with **no GitHub credential**; `dolt diff` is the board's changelog.
  The sweep and the webhook remain the write plane.

## Follow-ups that fell out (not this epic)

- Contract-first ordering for board schema changes (the reconcile ping-pong of
  2026-07-25: a sweep from stale `main` re-created fields deleted mid-PR — fixed
  by merging #81 first; the rule is "change the contract, let the room apply
  it").
- Agent/LLM estimation replacing the heuristic estimator behind the same seam.
- Incremental (delta) sync to cut the 1,314-point full-pull cost.
