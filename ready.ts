/**
 * @module
 * Front Desk ready queue — answers "what should I work on next?" from a Claude
 * Code session without opening the web UI. This is the CLI mirror of the
 * "Ready (ranked)" board view (contract.ts): eligible items (open, no open
 * blockers), highest Score first, with the signal breakdown behind each rank.
 *
 * Read-only — a personal GITHUB_TOKEN is fine (see CLAUDE.md). It computes
 * scores through the same `boardItemsToInputs` → `prioritize` path the sweep
 * writes back, so the printed order matches the board.
 *
 * Run:  deno run --allow-net=api.github.com --allow-env ready.ts [--top N] [--budget <id>]
 * Env:  GITHUB_TOKEN (read-only reach is enough)
 */

import {
  DEFAULT_WEIGHTS,
  ORG_BUDGETS,
  prioritize,
  type RankedItem,
} from "./prioritization.ts";
import { boardItemsToInputs } from "./board-inputs.ts";
import type { BoardItem } from "./projects.ts";

const DEFAULT_TOP = 10;

/** One row of the ready queue — a ranked item plus display-only extras. */
export interface ReadyRow {
  /** The scored/ranked item (score, eligible, fitsRemaining + all inputs). */
  readonly ranked: RankedItem;
  /** Human-legible handle, e.g. "gh-project-room#42". */
  readonly label: string;
  /** value/effort density — the estimated-path signal (0 when unestimated). */
  readonly density: number;
}

export interface ReadyReport {
  /** Eligible items only, ranked, capped to `top`. */
  readonly rows: readonly ReadyRow[];
  /** Total eligible items before the `top` cap (so truncation is visible). */
  readonly totalEligible: number;
  /** Budget the queue was scored against, if `--budget` was passed. */
  readonly budgetId?: string;
  /** True when `--budget` named a budget not in ORG_BUDGETS (fail-open). */
  readonly unknownBudget: boolean;
}

/**
 * Pure core: board items in, ranked ready rows out. No network, no token —
 * unit-testable exactly like `healthReport()`.
 *
 * `--budget` threads the budget's `capacityPoints` into `prioritize()` so each
 * row's `fitsRemaining` reflects the greedy walk down the queue; without it the
 * remaining capacity is `Infinity` (everything fits).
 */
export function readyReport(
  items: readonly BoardItem[],
  opts: { top?: number; budgetId?: string } = {},
): ReadyReport {
  const inputs = boardItemsToInputs(items);
  const budget = opts.budgetId ? ORG_BUDGETS.get(opts.budgetId) : undefined;
  const unknownBudget = opts.budgetId !== undefined && budget === undefined;
  const remaining = budget?.capacityPoints ?? Infinity;

  const ranked = prioritize(inputs, remaining, DEFAULT_WEIGHTS);
  // The "Ready (ranked)" contract: only actionable work (open, no open blocker).
  const eligible = ranked.filter((r) => r.eligible);

  const labelByNumber = new Map(
    items.map((i) => [i.number, `${i.repo}#${i.number}`]),
  );
  const top = opts.top ?? DEFAULT_TOP;
  const rows = eligible.slice(0, top).map((r): ReadyRow => ({
    ranked: r,
    label: labelByNumber.get(r.number) ?? `#${r.number}`,
    density: r.effort > 0 ? r.value / r.effort : 0,
  }));

  return {
    rows,
    totalEligible: eligible.length,
    budgetId: opts.budgetId,
    unknownBudget,
  };
}

// ---------------------------------------------------------------------------
// CLI — the only I/O. Fetches live board data via projects.ts, prints the queue.
// ---------------------------------------------------------------------------

interface Args {
  top?: number;
  budgetId?: string;
}

function parseArgs(args: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--top" && i + 1 < args.length) {
      const n = parseInt(args[++i], 10);
      if (!isNaN(n) && n > 0) out.top = n;
    } else if (args[i] === "--budget" && i + 1 < args.length) {
      out.budgetId = args[++i];
    }
  }
  return out;
}

function fmt(n: number): string {
  // Trim to 2dp but drop trailing ".00"/".x0" noise so the column stays tight.
  return (Math.round(n * 100) / 100).toString();
}

function printReady(report: ReadyReport): void {
  const showFits = report.budgetId !== undefined && !report.unknownBudget;
  if (report.unknownBudget) {
    console.log(
      `budget "${report.budgetId}" not found in ORG_BUDGETS — ignoring (all items fit)`,
    );
  }

  if (report.rows.length === 0) {
    console.log("No ready items — nothing is actionable right now.");
    return;
  }

  const header = [
    "#",
    "ITEM",
    "SCORE",
    "DENSITY",
    "UNBLOCKS",
    "KIND",
    "EFFORT",
  ];
  if (showFits) header.push("FITS");
  const rows = report.rows.map((row, i) => {
    const r = row.ranked;
    const cells = [
      String(i + 1),
      row.label,
      fmt(r.score),
      fmt(row.density),
      String(r.unblocks),
      r.kind,
      fmt(r.effort),
    ];
    if (showFits) cells.push(r.fitsRemaining ? "yes" : "no");
    return cells;
  });

  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((cells) => cells[c].length))
  );
  const line = (cells: string[]) =>
    cells.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd();

  console.log(line(header));
  for (const cells of rows) console.log(line(cells));

  const shown = report.rows.length;
  const budgetNote = showFits ? ` against budget "${report.budgetId}"` : "";
  console.log(
    `\n${shown} of ${report.totalEligible} ready item(s)${budgetNote}` +
      (shown < report.totalEligible ? ` (use --top to see more)` : ""),
  );
}

async function main(): Promise<void> {
  const { top, budgetId } = parseArgs(Deno.args);
  const { boardItems, getProject } = await import("./projects.ts");
  const project = await getProject();
  const board = await boardItems(project.id);
  printReady(readyReport(board, { top, budgetId }));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    Deno.exit(1);
  });
}
