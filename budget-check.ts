/**
 * CI budget circuit-breaker — the thin I/O wrapper around `budgetGate()`.
 *
 * Usage:
 *   deno run budget-check.ts --budget <id> [--about-to-spend <n>]
 *
 * Exits 0 when the gate allows, 1 when it blocks, 2 on bad arguments.
 *
 * Posture: fail-CLOSED on overspend; fail-OPEN when the budget id is
 * unknown or capacity is zero (never silently halt the org). Until
 * window-burn metering lands (#10), consumedPoints is treated as 0 and
 * only the static-envelope check (aboutToSpend vs capacityPoints) is
 * enforced — see `budgetGate()` in prioritization.ts.
 */

import {
  type EffortPoints,
  ORG_BUDGETS,
  budgetGate,
  planCapacity,
} from "./prioritization.ts";

interface Args {
  budgetId: string;
  aboutToSpend: EffortPoints;
}

function parseArgs(args: string[]): Args {
  let budgetId = "";
  let aboutToSpend: EffortPoints = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--budget" && i + 1 < args.length) {
      budgetId = args[++i];
    } else if (args[i] === "--about-to-spend" && i + 1 < args.length) {
      const n = parseFloat(args[++i]);
      if (!isNaN(n)) aboutToSpend = n;
    }
  }
  if (!budgetId) {
    console.error(
      "Usage: budget-check.ts --budget <id> [--about-to-spend <n>]",
    );
    Deno.exit(2);
  }
  return { budgetId, aboutToSpend };
}

if (import.meta.main) {
  const { budgetId, aboutToSpend } = parseArgs(Deno.args);

  const budget = ORG_BUDGETS.get(budgetId);
  if (!budget) {
    // Unknown budget — fail open so the org is never silently halted.
    console.log(
      `budget "${budgetId}" not found in ORG_BUDGETS — failing open (warn)`,
    );
    Deno.exit(0);
  }

  // consumedPoints: metering not yet wired (#10) — use 0 (fail-open posture).
  const consumedPoints: EffortPoints = 0;
  const report = planCapacity(budget, [], consumedPoints);
  const decision = budgetGate(report, aboutToSpend);

  console.log(decision.reason);
  Deno.exit(decision.allow ? 0 : 1);
}
