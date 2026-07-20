/**
 * @module
 * Front Desk ready queue — the ranked "what should I work on next?" core.
 *
 * This module is pure logic + a text renderer + the default board reader; the
 * dispatchable surface lives in verbs.ts as the `ready` verbspec verb (CLI +
 * MCP + OpenAPI for free, via the same VerbSpec). Split of concerns:
 *   - `readyReport()`  — pure ranking (board items in, ranked rows out).
 *   - `readyView()`    — flatten a report into the tool-facing shape (MCP
 *                        structuredContent / verb output).
 *   - `renderReadyTable()` — the human table (the verb's CLI `render`).
 *   - `fetchBoardItems()`  — the default `BoardReader` (this repo's Projects v2
 *                        client). Injected via the verb's `deps` so the read can
 *                        later be backed by scout-wire's `project` verb (the
 *                        scout door) without touching the ranking — see verbs.ts.
 */

import {
  DEFAULT_WEIGHTS,
  ORG_BUDGETS,
  prioritize,
  type RankedItem,
} from "./prioritization.ts";
import { boardItemsToInputs } from "./board-inputs.ts";
import type { BeadKind } from "./contract.ts";
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
  /** Budget the queue was scored against, if one was named. */
  readonly budgetId?: string;
  /** True when a named budget was not in ORG_BUDGETS (fail-open). */
  readonly unknownBudget: boolean;
}

/**
 * Pure core: board items in, ranked ready rows out. No network, no token —
 * unit-testable exactly like `healthReport()`.
 *
 * A budget threads its `capacityPoints` into `prioritize()` so each row's
 * `fitsRemaining` reflects the greedy walk down the queue; without one the
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
// Tool-facing projection — the verb output / MCP structuredContent shape.
// ---------------------------------------------------------------------------

/** A single ready item, flattened for the verb output (kept mutable so it
 * lines up 1:1 with the Zod output schema's inferred type in verbs.ts). */
export interface ReadyViewItem {
  rank: number;
  item: string;
  score: number;
  density: number;
  unblocks: number;
  kind: BeadKind;
  effort: number;
  fitsRemaining: boolean;
}

/** Object-shaped projection of a ReadyReport (so MCP advertises an outputSchema
 * and returns structuredContent rather than a bare array). */
export interface ReadyView {
  items: ReadyViewItem[];
  totalEligible: number;
  budgetId?: string;
  unknownBudget: boolean;
}

/** Round to 2dp. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Flatten a ReadyReport into the tool-facing ReadyView. Pure. */
export function readyView(report: ReadyReport): ReadyView {
  return {
    items: report.rows.map((row, i) => ({
      rank: i + 1,
      item: row.label,
      score: round2(row.ranked.score),
      density: round2(row.density),
      unblocks: row.ranked.unblocks,
      kind: row.ranked.kind,
      effort: row.ranked.effort,
      fitsRemaining: row.ranked.fitsRemaining,
    })),
    totalEligible: report.totalEligible,
    unknownBudget: report.unknownBudget,
    ...(report.budgetId !== undefined ? { budgetId: report.budgetId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Text renderer — the verb's human-facing CLI view.
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return round2(n).toString();
}

/** Render a ReadyView as an aligned text table (the `ready` verb's CLI view). */
export function renderReadyTable(view: ReadyView): string {
  const out: string[] = [];
  const showFits = view.budgetId !== undefined && !view.unknownBudget;
  if (view.unknownBudget) {
    out.push(
      `budget "${view.budgetId}" not found in ORG_BUDGETS — ignoring (all items fit)`,
    );
  }
  if (view.items.length === 0) {
    out.push("No ready items — nothing is actionable right now.");
    return out.join("\n");
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
  const rows = view.items.map((it) => {
    const cells = [
      String(it.rank),
      it.item,
      fmt(it.score),
      fmt(it.density),
      String(it.unblocks),
      it.kind,
      fmt(it.effort),
    ];
    if (showFits) cells.push(it.fitsRemaining ? "yes" : "no");
    return cells;
  });

  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((cells) => cells[c].length))
  );
  const line = (cells: string[]) =>
    cells.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd();

  out.push(line(header));
  for (const cells of rows) out.push(line(cells));

  const shown = view.items.length;
  const budgetNote = showFits ? ` against budget "${view.budgetId}"` : "";
  out.push(
    `\n${shown} of ${view.totalEligible} ready item(s)${budgetNote}` +
      (shown < view.totalEligible ? " (use --top to see more)" : ""),
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The board-read seam — the only I/O. Injected via the verb's `deps` so the
// read can be swapped (Projects v2 client today; scout's `project` verb later).
// ---------------------------------------------------------------------------

/** A source of board items — the seam that decouples the read from the ranking. */
export type BoardReader = () => Promise<readonly BoardItem[]>;

/**
 * Default reader: gh-project-room's own Projects v2 GraphQL client (projects.ts).
 * Works wherever a GITHUB_TOKEN is available (CI sweep, token CLI). A
 * scout-backed reader — calling scout-wire's `project` verb through the scout
 * door (door-kit → scoutd) — can be injected in its place inside the claude-box
 * sandbox, without changing the ranking. Read-only.
 */
export const fetchBoardItems: BoardReader = async () => {
  const { boardItems, getProject } = await import("./projects.ts");
  const project = await getProject();
  return boardItems(project.id);
};
