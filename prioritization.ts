/**
 * Front Desk prioritization contract — the codeable core of the behavioral
 * product (spike: spike-behavioral-prioritization.md).
 *
 * Front Desk only earns its keep if "what should I work on next?" is a function
 * of board state, not a vibe. This module is that function. It is the single
 * source the room renders three ways:
 *   1. the Concierge's ready queue   — `prioritize()` (what a guest picks up)
 *   2. capacity planning             — `planCapacity()` (does the plan fit?)
 *   3. the CI budget guardrail       — `budgetGate()` (may an agent spend more?)
 *
 * Design constraints (from the spike):
 *   - Effort is denominated in ABSTRACT points, decoupled from any one provider,
 *     plus an explicit ConversionMapping to a concrete metered unit.
 *   - A Budget is a HYBRID of a usage *window* (the time/reset dimension) and a
 *     *capacity over that window* (the points dimension). Milestones ARE budgets.
 *   - Capacity is judged on BOTH axes at once — the static envelope (does the
 *     sum of planned effort fit?) AND the live burn (rolling consumption inside
 *     the window vs the limit). Not envelope-vs-burn; both.
 *
 * Hotel framing: gh-project-room (a ROOM) computes this; the Concierge (the
 * guest-assist tool) serves it to a GUEST (agent). Pure data + types, no I/O,
 * explicit return types (JSR "no slow types") so it lifts into the standalone
 * package alongside contract.ts (see #58).
 */

import type { BeadKind, BeadState } from "./contract.ts";

// ---------------------------------------------------------------------------
// Effort — abstract points + conversion to a concrete metered unit.
// ---------------------------------------------------------------------------

/**
 * Provider-neutral unit of agent effort. Deliberately abstract: estimating in
 * points keeps the contract stable while the concrete cost model (tokens, hours,
 * usage-window fraction) evolves under it via `ConversionMapping`.
 */
export type EffortPoints = number;

/** The concrete, metered units points can be converted into. */
export type MeteredUnit =
  | "tokens"
  | "agent-hours"
  | "usage-window-fraction"
  | "usd";

/**
 * Maps abstract effort points onto a concrete metered unit. Keeping this
 * separate from the budget means the same plan can be costed against several
 * meters (tokens for spend, hours for wall-clock) without re-estimating work.
 */
export interface ConversionMapping {
  readonly unit: MeteredUnit;
  /** Concrete units consumed per effort point (1 point → `unitPerPoint` units). */
  readonly unitPerPoint: number;
}

/** Convert an effort estimate into concrete metered units. */
export function toUnits(points: EffortPoints, mapping: ConversionMapping): number {
  return points * mapping.unitPerPoint;
}

// ---------------------------------------------------------------------------
// Budgets — the hybrid (window × capacity-over-window). A milestone IS a budget.
// ---------------------------------------------------------------------------

/**
 * The time/reset dimension of a budget.
 *   - `rolling`  — a sliding window that refills continuously (e.g. Claude's 5h
 *                  rolling limit): consumption older than `durationHours` ago no
 *                  longer counts against the cap.
 *   - `calendar` — a fixed window that resets on a boundary (e.g. weekly).
 */
export interface UsageWindow {
  readonly kind: "rolling" | "calendar";
  readonly durationHours: number;
  /** Human label used on the milestone / board (e.g. "5h", "weekly"). */
  readonly label: string;
}

/**
 * A budget = a usage window + the effort capacity permitted within it, plus the
 * conversion to a concrete meter. This is what a Front Desk milestone projects
 * to: "Milestone: weekly-2" is a `calendar`/168h window with N points of
 * capacity. Capacity planning and the CI gate both read this one shape.
 */
export interface Budget {
  /** Stable id; mirrors the milestone title on the board. */
  readonly id: string;
  readonly window: UsageWindow;
  /** Effort points allowed within one window. */
  readonly capacityPoints: EffortPoints;
  readonly conversion: ConversionMapping;
}

// ---------------------------------------------------------------------------
// Work items — the priority inputs projected from a bead / board item.
// ---------------------------------------------------------------------------

/**
 * The slice of a work item the prioritizer needs. Projected from a
 * `BeadWorkItem` (contract.ts) plus its edge graph; `value` and `effort` are the
 * two estimates a human or a generating agent supplies.
 */
export interface PriorityInput {
  readonly number: number;
  readonly title: string;
  readonly kind: BeadKind;
  readonly state: BeadState;
  /** Estimated agent effort to take this to Done. */
  readonly effort: EffortPoints;
  /** Business value / urgency, 0–100. Higher = more worth doing now. */
  readonly value: number;
  /** Count of unresolved inbound `blocks` edges — >0 means not actionable yet. */
  readonly openBlockers: number;
  /** Count of downstream items this one unblocks (critical-path leverage). */
  readonly unblocks: number;
  /** The budget (milestone) this item is assigned to, if any. */
  readonly budgetId?: string;
}

/** A scored, ranked item — the output unit of `prioritize()`. */
export interface RankedItem extends PriorityInput {
  /** Actionable now: state is open/in_progress AND no open blockers. */
  readonly eligible: boolean;
  /** Composite priority score (higher first). 0 for ineligible items. */
  readonly score: number;
  /** Would this item still fit the budget's remaining capacity when reached? */
  readonly fitsRemaining: boolean;
}

// ---------------------------------------------------------------------------
// Scoring & ranking — the Concierge's ready queue.
// ---------------------------------------------------------------------------

/** Tunable weights for the composite score. Defaults favour flow then value. */
export interface ScoreWeights {
  /** Weight on value-density (value per effort point). */
  readonly density: number;
  /** Weight on critical-path leverage (downstream items unblocked). */
  readonly flow: number;
  /** Penalty per effort point — nudges toward smaller, shippable work. */
  readonly effortPenalty: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  density: 1,
  flow: 2,
  effortPenalty: 0.05,
};

/** An item is actionable when its lifecycle is live and nothing blocks it. */
export function isEligible(item: PriorityInput): boolean {
  const live = item.state === "open" || item.state === "in_progress";
  return live && item.openBlockers === 0;
}

/**
 * Composite priority score. Eligible items only — ineligible items score 0 so
 * they sink below anything actionable. Effort guards against divide-by-zero.
 */
export function score(item: PriorityInput, weights: ScoreWeights = DEFAULT_WEIGHTS): number {
  if (!isEligible(item)) return 0;
  const effort = Math.max(item.effort, 1);
  const density = item.value / effort;
  return weights.density * density +
    weights.flow * item.unblocks -
    weights.effortPenalty * effort;
}

/**
 * Rank a set of items into the ready queue, capacity-aware.
 *
 * Order: eligible-and-fits first (by score desc), then eligible-but-too-big,
 * then ineligible. `remainingPoints` is decremented greedily as fitting items
 * are selected, so `fitsRemaining` reflects the queue position, not just the
 * raw budget — this is the `bd ready` queue an agent should walk top-down.
 */
export function prioritize(
  items: readonly PriorityInput[],
  remainingPoints: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): RankedItem[] {
  const scored = items.map((item) => ({
    item,
    eligible: isEligible(item),
    s: score(item, weights),
  }));
  // Highest score first; ties broken by smaller effort (ship sooner).
  scored.sort((a, b) => b.s - a.s || a.item.effort - b.item.effort);

  let budgetLeft = remainingPoints;
  return scored.map(({ item, eligible, s }) => {
    const fitsRemaining = eligible && item.effort <= budgetLeft;
    if (fitsRemaining) budgetLeft -= item.effort;
    return { ...item, eligible, score: s, fitsRemaining };
  });
}

// ---------------------------------------------------------------------------
// Capacity planning — BOTH the static envelope AND the live burn, at once.
// ---------------------------------------------------------------------------

/** Health of a budget on both axes. `over` on either axis is `over`. */
export type CapacityStatus = "ok" | "at-risk" | "over";

/**
 * A reading of one budget that folds together the two questions the spike
 * insists on keeping distinct-but-simultaneous:
 *   - PLANNED (static envelope): does the sum of assigned effort fit capacity?
 *   - CONSUMED (live burn): how much of this window has already been spent?
 */
export interface CapacityReport {
  readonly budget: Budget;
  /** Sum of effort assigned to this budget (the static envelope question). */
  readonly plannedPoints: EffortPoints;
  /** Planned effort fits within capacity. */
  readonly plannedFits: boolean;
  /** Effort already burned inside the current window (the live-burn question). */
  readonly consumedPoints: EffortPoints;
  /** Capacity not yet consumed in this window (never below 0). */
  readonly remainingPoints: EffortPoints;
  /** consumed / capacity, 0–1+ (the circuit-breaker signal). */
  readonly burnRatio: number;
  /** Worst of the two axes, with `at-risk` for the warning band. */
  readonly status: CapacityStatus;
  /** Planned effort costed into the budget's concrete meter. */
  readonly plannedUnits: number;
}

/** The burn ratio above which a budget is flagged `at-risk` (below `over`). */
export const AT_RISK_THRESHOLD = 0.8;

/**
 * Evaluate a budget on both axes. `consumedPoints` is the caller's measured burn
 * inside the current window (rolling or calendar — the meter lives in the room,
 * not here). `plannedItems` are everything assigned to this budget.
 */
export function planCapacity(
  budget: Budget,
  plannedItems: readonly PriorityInput[],
  consumedPoints: EffortPoints,
): CapacityReport {
  const plannedPoints = plannedItems.reduce((sum, i) => sum + i.effort, 0);
  const plannedFits = plannedPoints <= budget.capacityPoints;
  const remainingPoints = Math.max(budget.capacityPoints - consumedPoints, 0);
  const burnRatio = budget.capacityPoints > 0
    ? consumedPoints / budget.capacityPoints
    : Infinity;

  const overBurn = burnRatio >= 1;
  const status: CapacityStatus = (overBurn || !plannedFits)
    ? "over"
    : (burnRatio >= AT_RISK_THRESHOLD ? "at-risk" : "ok");

  return {
    budget,
    plannedPoints,
    plannedFits,
    consumedPoints,
    remainingPoints,
    burnRatio,
    status,
    plannedUnits: toUnits(plannedPoints, budget.conversion),
  };
}

// ---------------------------------------------------------------------------
// CI guardrail — the generative half: one contract, also the budget gate.
// ---------------------------------------------------------------------------

/** Decision returned to a CI step or a dispatching room. */
export interface GateDecision {
  /** May new agent work proceed against this budget? */
  readonly allow: boolean;
  /** Human-readable rationale (logged to the step summary / PR check). */
  readonly reason: string;
}

/**
 * The budget circuit-breaker. Fail-CLOSED on overspend (block new agent work
 * once the window's burn meets/exceeds the cap), fail-OPEN otherwise — a missing
 * or zero-capacity budget never silently halts the org; it warns and proceeds.
 *
 * `additionalPoints` is the effort of the work about to be dispatched, so a
 * single large item that would tip the window over the cap is caught before it
 * starts, not after.
 */
export function budgetGate(
  report: CapacityReport,
  additionalPoints: EffortPoints = 0,
): GateDecision {
  const { budget, consumedPoints, status } = report;

  if (budget.capacityPoints <= 0) {
    return { allow: true, reason: `budget "${budget.id}" has no capacity set — failing open (warn)` };
  }
  const projected = consumedPoints + additionalPoints;
  if (projected >= budget.capacityPoints) {
    return {
      allow: false,
      reason:
        `budget "${budget.id}" exhausted: ${projected}/${budget.capacityPoints} pts ` +
        `(${budget.window.label} window) — blocking new agent work until reset`,
    };
  }
  if (status === "at-risk") {
    return {
      allow: true,
      reason:
        `budget "${budget.id}" at ${(report.burnRatio * 100).toFixed(0)}% of ` +
        `${budget.window.label} window — proceeding, triage soon`,
    };
  }
  return { allow: true, reason: `budget "${budget.id}" healthy (${projected}/${budget.capacityPoints} pts)` };
}
