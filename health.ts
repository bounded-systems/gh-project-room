/**
 * @module
 * Front Desk health — the self-check the charter (docs/front-desk-charter.md,
 * #52) promises: one row per invariant, computed from data the room already
 * fetches. `healthReport()` is pure (data in, Scorecard out) so it is
 * unit-testable without network access; the CLI at the bottom does the only
 * I/O — fetch via `projects.ts`, print.
 *
 * Metrics, per #62:
 *   1. Coverage      — open public issues/PRs not on the board (want 0).
 *   2. Contract      — private-repo items on the (public) board (want 0).
 *   3. Traceability, hard — merged PRs closing ≥2 issues (want 0; #52 invariant 2).
 *   4. Traceability, soft — merged PRs closing 0 issues, honoring the
 *      exemption contract (a report, not a gate — visibility only; #55).
 *   5. Prioritization — Score variance across open items (want > 0; #60).
 *   6. Status freshness — board Status vs the item's actual GitHub state
 *      (want 0 stale; measures the #53 gap).
 */

import type { BoardItem, MergedPRInfo, OrgWorkItems } from "./projects.ts";
import { type BoardReads, directReads } from "./reads.ts";

export type HealthRowKind = "gate" | "report";

export interface HealthRow {
  readonly metric: string;
  /** "gate" fails the overall check; "report" is visibility-only (never fails it). */
  readonly kind: HealthRowKind;
  readonly value: number;
  readonly ok: boolean;
  readonly detail: string;
  readonly offenders: readonly string[];
}

export interface Scorecard {
  readonly rows: readonly HealthRow[];
  /** AND of every `kind: "gate"` row's `ok`. Report rows never affect this. */
  readonly allGatesPass: boolean;
}

export interface HealthInput {
  readonly board: readonly BoardItem[];
  readonly openWork: OrgWorkItems;
  readonly mergedPRs: readonly MergedPRInfo[];
}

const OFFENDER_LIMIT = 20;

function capOffenders(all: readonly string[]): string[] {
  if (all.length <= OFFENDER_LIMIT) return [...all];
  return [
    ...all.slice(0, OFFENDER_LIMIT),
    `… +${all.length - OFFENDER_LIMIT} more`,
  ];
}

function variance(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
}

/**
 * A merged PR the charter's exemption contract excuses from needing a closing
 * issue (release/publish + automated-dependency PRs — see
 * docs/front-desk-charter.md § Exemption contract). Interim heuristic: the
 * charter's stated target is a machine-readable config; this is that config's
 * first cut, kept in code until #55 needs to reuse it elsewhere.
 */
export function isExemptFromClosingIssue(pr: MergedPRInfo): boolean {
  const automatedDependencyAuthor = pr.authorLogin === "dependabot[bot]" ||
    pr.authorLogin === "renovate[bot]";
  const dependencyLabel = pr.labels.some((l) =>
    l.toLowerCase() === "dependencies"
  );
  const releaseTitle = /^(chore: )?release\b/i.test(pr.title);
  const releaseLabel = pr.labels.some((l) => l.toLowerCase() === "release");
  return automatedDependencyAuthor || dependencyLabel || releaseTitle ||
    releaseLabel;
}

/** Compute the Front Desk health scorecard from already-fetched board/repo/PR data. */
export function healthReport(input: HealthInput): Scorecard {
  const onBoard = new Set(input.board.map((b) => b.contentId));

  const missingCoverage = input.openWork.items.filter((w) =>
    !onBoard.has(w.id)
  );
  const coverage: HealthRow = {
    metric: "Coverage (open public items not on board)",
    kind: "gate",
    value: missingCoverage.length,
    ok: missingCoverage.length === 0,
    detail: `${missingCoverage.length} open item(s) missing from Front Desk`,
    offenders: capOffenders(
      missingCoverage.map((w) => `${w.repo}#${w.number}`),
    ),
  };

  const leaked = input.board.filter((b) => b.isPrivate);
  const contract: HealthRow = {
    metric: "Contract (private-repo items on board)",
    kind: "gate",
    value: leaked.length,
    ok: leaked.length === 0,
    detail: `${leaked.length} private-repo item(s) on the board`,
    offenders: capOffenders(leaked.map((b) => `${b.repo}#${b.number}`)),
  };

  const conflated = input.mergedPRs.filter((p) => p.closingIssueCount > 1);
  const traceabilityHard: HealthRow = {
    metric: "Traceability — conflated (merged PRs closing ≥2 issues)",
    kind: "gate",
    value: conflated.length,
    ok: conflated.length === 0,
    detail: `${conflated.length} merged PR(s) close more than one issue`,
    offenders: capOffenders(conflated.map((p) => `${p.repo}#${p.number}`)),
  };

  const offRoadmap = input.mergedPRs.filter(
    (p) => p.closingIssueCount === 0 && !isExemptFromClosingIssue(p),
  );
  const traceabilitySoft: HealthRow = {
    metric:
      "Traceability — off-roadmap (merged PRs closing 0 issues, non-exempt)",
    kind: "report",
    value: offRoadmap.length,
    ok: true,
    detail: `${offRoadmap.length} merged PR(s) have no closing issue`,
    offenders: capOffenders(offRoadmap.map((p) => `${p.repo}#${p.number}`)),
  };

  const openScores = input.board
    .filter((b) => b.fields.status !== "Done")
    .map((b) => b.fields.score)
    .filter((s): s is number => s !== null);
  const scoreVariance = variance(openScores);
  // Variance needs >=2 points to be meaningful; fewer is "not enough data",
  // not a violation, so it passes vacuously rather than always failing.
  const prioritization: HealthRow = {
    metric: "Prioritization (Score variance across open items)",
    kind: "gate",
    value: Math.round(scoreVariance * 10000) / 10000,
    ok: openScores.length < 2 || scoreVariance > 0,
    detail: openScores.length < 2
      ? `${openScores.length} scored open item(s) — not enough data`
      : `variance=${
        scoreVariance.toFixed(4)
      } over ${openScores.length} item(s)`,
    offenders: [],
  };

  const stale = input.board.filter((b) => {
    const shouldBeDone = b.ghState === "CLOSED" || b.ghState === "MERGED";
    const isDone = b.fields.status === "Done";
    return shouldBeDone !== isDone;
  });
  const statusFreshness: HealthRow = {
    metric: "Status freshness (board Status vs GitHub state)",
    kind: "gate",
    value: stale.length,
    ok: stale.length === 0,
    detail: `${stale.length} item(s) have a stale Status`,
    offenders: capOffenders(
      stale.map((b) =>
        `${b.repo}#${b.number} (Status=${
          b.fields.status ?? "unset"
        }, GH=${b.ghState})`
      ),
    ),
  };

  const rows = [
    coverage,
    contract,
    traceabilityHard,
    traceabilitySoft,
    prioritization,
    statusFreshness,
  ];
  return {
    rows,
    allGatesPass: rows.filter((r) => r.kind === "gate").every((r) => r.ok),
  };
}

// ---------------------------------------------------------------------------
// CLI — the only I/O. Fetches live data via projects.ts, prints the scorecard.
// ---------------------------------------------------------------------------

function printScorecard(card: Scorecard): void {
  for (const row of card.rows) {
    const badge = row.kind === "report" ? "REPORT" : (row.ok ? "OK" : "FAIL");
    console.log(`[${badge}] ${row.metric}: ${row.detail}`);
    for (const o of row.offenders) console.log(`    - ${o}`);
  }
  console.log(
    card.allGatesPass ? "\nAll gates pass." : "\nSome gates are failing.",
  );
}

async function main(reads: BoardReads = directReads): Promise<void> {
  const project = await reads.getProject();
  const [board, openWork, merged] = await Promise.all([
    reads.boardItems(project.id),
    reads.orgOpenWorkItems(),
    reads.orgMergedPullRequests(),
  ]);
  if (openWork.skipped.length) {
    console.log(
      `(skipped ${openWork.skipped.length} unreadable repo(s) for coverage: ${
        openWork.skipped.map((s) => s.repo).join(", ")
      })`,
    );
  }
  if (merged.skipped.length) {
    console.log(
      `(skipped ${merged.skipped.length} unreadable repo(s) for traceability: ${
        merged.skipped.map((s) => s.repo).join(", ")
      })`,
    );
  }
  const card = healthReport({ board, openWork, mergedPRs: merged.items });
  printScorecard(card);
  if (!card.allGatesPass) Deno.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    Deno.exit(1);
  });
}
