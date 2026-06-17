# Spike — Front Desk as a behavioral product: a codeable prioritization contract

**Status:** spike / exploratory. Pairs with the runnable sketch in
`prioritization.ts`. Not yet wired into the sweep.

**Question it answers:** how does Front Desk stop being a passive board and
become the thing an agent (a Claude guest) consults to decide *what to do next*,
*for how much effort*, and *whether it's even allowed to spend more right now* —
all computed from a contract, not vibes.

---

## 1. Thesis: Front Desk is only "helpful" if priority is a function

Front Desk is decorative unless it is the **first place work is selected** (this
is exactly the helpfulness criterion in #62). For a human, "first place I look"
is a habit. For an **agent**, it has to be a *callable function* — given the
board state, return the next eligible item that fits the budget. So the product
is not the board; the board is the rendered state. The product is:

> `prioritize(items, remainingBudget) → ranked ready queue`
> `budgetGate(budget, aboutToSpend) → allow / deny`

If those two functions are good, Front Desk drives behavior. Everything else
(views, charts, fields) is a projection of their inputs and outputs.

## 2. Is it a room? Yes — and the advisor is the Concierge

Hotel framing (see `docs/org-map.md`):

| Concept | Here |
|---|---|
| **Room** (process) | `gh-project-room` — already runs `sync`/`apply`. This spike gives it a second job: **compute priority + enforce budget**. |
| **Door** (capabilities) | Org Projects R/W (has it) **+ a usage/metering read** (new — to measure burn). |
| **Front Desk** | the board: the *surface* the room renders onto. |
| **Guest** (agent) | a Claude session that asks "what should I pick up?" |
| **Concierge** | the reserved "guest-assist tool" — its purpose is now concrete: it serves `prioritize()` to the guest and respects `budgetGate()`. |

So: **one room** computes and guards; **the Concierge** advises the guest. We are
*not* spinning up a new "front-desk repo that works on everything" — that's the
room we already have, graduating (#58) with a richer contract. The room works on
everything because it enumerates every repo's open work already (`orgOpenWorkItems`).

## 3. The codeable contract (`prioritization.ts`)

One module, three consumers — the "generative contract" idea: the same source of
truth renders the board schema, the agent's queue, and the CI gate.

```
                    prioritization.ts (this contract)
                    /            |             \
        Concierge ready     capacity planning    CI budget gate
        queue (guest)       (planning view)      (prevents overspend)
        prioritize()        planCapacity()       budgetGate()
```

### 3.1 Effort is abstract, with an explicit conversion

Work is estimated in provider-neutral **`EffortPoints`**. A separate
**`ConversionMapping`** ties points to a concrete meter (`tokens`, `agent-hours`,
`usage-window-fraction`, `usd`). This keeps estimates stable while the cost model
changes underneath, and lets the *same* plan be costed against several meters
(tokens for spend, hours for wall-clock) without re-estimating.

```ts
1 EffortPoint × { unit: "tokens", unitPerPoint: 50_000 } → 50k tokens
1 EffortPoint × { unit: "agent-hours", unitPerPoint: 0.5 } → 30 min
```

### 3.2 Milestones are budgets, and a budget is a *hybrid*

A milestone is not a date — it's a **`Budget`**: a **usage `window`** (the
time/reset axis) **×** a **`capacityPoints`** (the effort-over-that-window axis).

- `rolling` window — a sliding limit that refills continuously (Claude's 5h
  rolling cap): spend older than `durationHours` stops counting.
- `calendar` window — fixed, resets on a boundary (weekly).

This is the deliberate hybrid: a budget binds *how much* to *over what window*.
"Milestone: weekly-2" = a 168h calendar window with N points of capacity.

### 3.3 Capacity is judged on BOTH axes at once

The decision from the spike review: **not envelope-vs-burn — both.**

- **Static envelope:** does `Σ effort(assigned items) ≤ capacity`? (the plan)
- **Live burn:** how much of *this* window is already consumed? (the meter)

`planCapacity()` returns one `CapacityReport` carrying both — `plannedFits`
(envelope) *and* `burnRatio`/`remainingPoints` (burn) — and a `status` that is
the worse of the two (`over` if either the plan doesn't fit *or* the window is
spent). A plan can fit the envelope yet still be blocked because the rolling
window is exhausted right now, and vice-versa. You always see both numbers.

### 3.4 The ready queue is capacity-aware

`prioritize()` scores eligible items (`isEligible` = live state **and** zero open
blockers — the `bd ready` rule) by a composite of:

- **value-density** — value per effort point (do the cheap-but-valuable first),
- **flow / critical-path** — how many downstream items it unblocks (weighted
  highest by default; unblocking work compounds),
- minus a small **effort penalty** — nudge toward shippable increments.

Then it walks the sorted list decrementing remaining budget, so `fitsRemaining`
reflects the item's *queue position*, not just the raw cap. The top item an agent
can actually afford is the one to pick up.

## 4. CI guardrail — the generative half (prevent excessive agent usage)

The same contract generates a **budget circuit-breaker** that runs in CI before
agent work is dispatched. `budgetGate()` is:

- **fail-closed on overspend** — once `consumed + about-to-spend ≥ capacity` for
  the window, new agent work is **blocked** until the window resets;
- **fail-open otherwise** — a missing or zero-capacity budget *warns and
  proceeds* (never silently halts the org — same posture as `front-desk-add`'s
  fail-open guard).

### Sketch: `front-desk-budget` check (illustrative, not yet wired)

```yaml
# .github/workflows/front-desk-budget.yml  (SKETCH)
name: front-desk-budget
on:
  workflow_call:
    inputs:
      budget_id: { type: string, required: true }
      about_to_spend: { type: number, default: 0 }
jobs:
  gate:
    runs-on: ubuntu-latest
    environment: front-desk
    steps:
      - uses: actions/checkout@<pinned>
      - uses: denoland/setup-deno@<pinned>
        with: { deno-version: v2.x }
      - name: Evaluate budget gate
        env:
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
        run: |
          # budget-check.ts: read the budget + measured window burn (metering
          # door), call budgetGate(), exit non-zero when allow=false.
          deno run --allow-net=api.github.com --allow-env \
            docs/handoffs/gh-project-room/budget-check.ts \
            --budget "${{ inputs.budget_id }}" \
            --about-to-spend "${{ inputs.about_to_spend }}"
```

A dispatching room (or a `claude-box` session launcher) `workflow_call`s this
before spinning up a guest; a non-zero exit means "the window is spent, wait."
The decision logic lives in `prioritization.ts::budgetGate` (pure, testable);
`budget-check.ts` is the thin I/O wrapper that supplies the measured burn.

> **Metering is the missing door.** The gate needs a real `consumedPoints` for
> the current window. That measurement (token/usage telemetry per window) is the
> one new capability this needs — candidate tie-in to the OTLP/telemetry work in
> #75. Until it exists, the gate fails open and only the *static envelope* half
> is enforceable.

## 5. How it projects onto the board

The contract is abstract; Front Desk renders it with fields + views + charts the
sweep already knows how to reconcile (`contract.ts`):

| Contract concept | Board surface | Status |
|---|---|---|
| `effort` (points) | `Effort` — new NUMBER field | proposed |
| `value` | `Value` — new NUMBER field | proposed |
| `budgetId` | native `Milestone` (= budget id) | exists (assignment manual, #78) |
| `openBlockers` | `Depends on` / structured edges | partial (#55) |
| ready queue | a **"Ready (ranked)"** view, sorted by computed score | needs a written-back score field |
| `CapacityReport` | a **"Capacity"** Insights chart (planned vs consumed per budget) | proposed |
| `budgetGate` | a required `front-desk-budget` check | sketch |

The new bit vs today's read-only sweep: priority/score and capacity are
*computed*, so to render them as board fields the room must **write back** a
`Score` (and maybe `Eligible`) field per item — the first time the room sets
derived values beyond `Kind` (#51). That's the main new write surface.

## 6. Risks / open questions

1. **Estimates.** `effort` and `value` have to come from somewhere. Options: a
   human sets them, or a generating agent proposes them from the issue body
   (front-matter / an LLM estimate) — itself an agent-usage cost to budget.
2. **Metering fidelity.** Rolling-window burn needs per-window usage telemetry
   we don't collect yet (#75). Without it only the static envelope is real.
3. **Write-back churn.** Writing `Score` every sweep mutates many items each run;
   needs the parallelism in #53 and care not to thrash the activity feed.
4. **Gaming the score.** Weighting `flow` highest could starve genuinely urgent
   leaf work; weights are tunable (`ScoreWeights`) but need real data (#62).
5. **Where it lives.** This is still incubating in `.github-private`; graduation
   to `@bounded-systems/gh-project-room` is #58 once stable.

## 7. Proposed next steps (filed as issues)

- [ ] **#97** — add `Effort` + `Value` NUMBER fields to `FRONT_DESK_FIELDS`; teach
      `applyField` the NUMBER dataType (small, mirrors the DATE add in #92).
- [ ] **#98** — room writes back a computed `Score` field + ranked Ready view
      (first derived write-back).
- [ ] **#99** — define the org's standard budgets (a `rolling` 5h and a
      `calendar` weekly) as `Budget` constants; map milestones to them.
- [ ] **#100** — implement `budget-check.ts` + the `front-desk-budget` workflow;
      fail open until metering lands.
- [ ] **#101** — wire window-burn metering (depends on #75 telemetry).
- [ ] **#102** — a "Capacity" Insights chart (planned vs consumed per budget).

## References

- `prioritization.ts` — the runnable contract this doc describes.
- `contract.ts` — board schema (fields/views/workflows/insights) the room reconciles.
- #62 helpfulness criteria · #55 structured edges · #53 parallel sync ·
  #75 telemetry/OTLP · #78 milestones · #58 extraction.
