/**
 * @module
 * Front Desk health — auto-file/auto-close the tracking issue (#64), the top
 * of the dogfood ladder: when a gate invariant is red, open or update ONE
 * issue describing the breach (idempotent — found by a stable marker in the
 * body, never duplicated); when every gate is green again, close it.
 *
 * Folded into the weekly sweep (front-desk-sync.yml) as an extra step reusing
 * its already-minted Front Desk token — no separate schedule or token mint.
 * The tracking issue lives in gh-project-room itself, alongside the charter
 * issues it reports on.
 *
 * Usage: deno run --allow-net=api.github.com --allow-env health-issue.ts
 * Env: GITHUB_TOKEN (Front Desk App token — same one health.ts's CLI uses;
 * needs `issues: write`, which the installed App already grants)
 */

import {
  boardItems,
  getProject,
  orgMergedPullRequests,
  orgOpenWorkItems,
} from "./projects.ts";
import { healthReport, type HealthRow, type Scorecard } from "./health.ts";
import { ORG } from "./contract.ts";

export const TRACKING_REPO = "gh-project-room";
export const TRACKING_MARKER = "<!-- front-desk-health-tracking-issue -->";
export const TRACKING_TITLE = "Front Desk health: invariant(s) red";

/** Render the tracking issue body from the scorecard's failing gate rows. */
export function formatTrackingBody(rows: readonly HealthRow[]): string {
  const failing = rows.filter((r) => r.kind === "gate" && !r.ok);
  const lines = [
    TRACKING_MARKER,
    "",
    "Auto-filed by the weekly Front Desk health sweep (#64) — closes " +
    "automatically once every gate is green again. Do not edit the marker above.",
    "",
  ];
  for (const row of failing) {
    lines.push(`## ${row.metric}`);
    lines.push(row.detail);
    if (row.offenders.length) {
      lines.push("");
      for (const o of row.offenders) lines.push(`- ${o}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface ExistingTrackingIssue {
  readonly number: number;
  readonly state: "open" | "closed";
}

export type TrackingAction =
  | { readonly kind: "noop"; readonly reason: string }
  | { readonly kind: "close"; readonly issueNumber: number }
  | { readonly kind: "create"; readonly body: string }
  | {
    readonly kind: "update";
    readonly issueNumber: number;
    readonly body: string;
  }
  | {
    readonly kind: "reopen";
    readonly issueNumber: number;
    readonly body: string;
  };

/**
 * Pure decision: what to do given the scorecard's pass/fail and whatever
 * tracking issue (if any) already exists. No network, no GitHub state beyond
 * what's passed in — the four cases the AC calls for (open, update, close,
 * and the idempotent "already handled" no-ops).
 */
export function decideTrackingAction(
  card: Scorecard,
  existing: ExistingTrackingIssue | null,
): TrackingAction {
  if (card.allGatesPass) {
    if (existing?.state === "open") {
      return { kind: "close", issueNumber: existing.number };
    }
    return {
      kind: "noop",
      reason: existing
        ? "all gates green — tracking issue already closed"
        : "all gates green — no tracking issue to close",
    };
  }
  const body = formatTrackingBody(card.rows);
  if (!existing) return { kind: "create", body };
  if (existing.state === "open") {
    return { kind: "update", issueNumber: existing.number, body };
  }
  return { kind: "reopen", issueNumber: existing.number, body };
}

// ---------------------------------------------------------------------------
// CLI — the only I/O. Fetches the scorecard + tracking issue, applies the action.
// ---------------------------------------------------------------------------

async function gh<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "gh-project-room",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

interface SearchIssue {
  readonly number: number;
  readonly state: "open" | "closed";
}

async function findTrackingIssue(
  token: string,
): Promise<ExistingTrackingIssue | null> {
  const q = encodeURIComponent(
    `repo:${ORG}/${TRACKING_REPO} in:body "${TRACKING_MARKER}"`,
  );
  const data = await gh<{ items: SearchIssue[] }>(
    token,
    `/search/issues?q=${q}`,
  );
  const found = data.items[0];
  return found ? { number: found.number, state: found.state } : null;
}

async function applyAction(
  token: string,
  action: TrackingAction,
): Promise<void> {
  const repoPath = `/repos/${ORG}/${TRACKING_REPO}/issues`;
  switch (action.kind) {
    case "noop":
      console.log(action.reason);
      return;
    case "close":
      await gh(token, `${repoPath}/${action.issueNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "All gates green again — closing." }),
      });
      await gh(token, `${repoPath}/${action.issueNumber}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
      console.log(
        `closed tracking issue #${action.issueNumber} — all gates green`,
      );
      return;
    case "create": {
      const created = await gh<{ number: number }>(token, repoPath, {
        method: "POST",
        body: JSON.stringify({
          title: TRACKING_TITLE,
          body: action.body,
          labels: ["task"],
        }),
      });
      console.log(`filed tracking issue #${created.number}`);
      return;
    }
    case "update":
      await gh(token, `${repoPath}/${action.issueNumber}`, {
        method: "PATCH",
        body: JSON.stringify({ body: action.body }),
      });
      console.log(`updated tracking issue #${action.issueNumber}`);
      return;
    case "reopen":
      await gh(token, `${repoPath}/${action.issueNumber}`, {
        method: "PATCH",
        body: JSON.stringify({ body: action.body, state: "open" }),
      });
      console.log(`reopened tracking issue #${action.issueNumber}`);
      return;
  }
}

async function main(): Promise<void> {
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) {
    console.error("GITHUB_TOKEN is not set.");
    Deno.exit(2);
  }

  const project = await getProject();
  const [board, openWork, merged] = await Promise.all([
    boardItems(project.id),
    orgOpenWorkItems(),
    orgMergedPullRequests(),
  ]);
  const card = healthReport({ board, openWork, mergedPRs: merged.items });
  const existing = await findTrackingIssue(token);
  const action = decideTrackingAction(card, existing);
  await applyAction(token, action);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    Deno.exit(1);
  });
}
