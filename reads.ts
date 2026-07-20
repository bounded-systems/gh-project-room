/**
 * @module
 * The read seam — every "query"/"get" gh-project-room makes against GitHub,
 * behind one injectable port. Callers (sync.ts, health.ts, the `ready` verb)
 * depend on `BoardReads` (or a slice of it) rather than importing the concrete
 * Projects v2 client directly, so the read source can be swapped per environment.
 *
 * Two adapters, one seam:
 *   - `directReads` (default) — this repo's own Projects v2 GraphQL client
 *     (projects.ts). Works wherever a GITHUB_TOKEN is present: the CI sweep
 *     (front-desk-sync.yml runs in GitHub Actions, outside claude-box) and any
 *     token CLI.
 *   - a scout-backed adapter (follow-up, not here) — routes each read through
 *     scout-wire's `project`/`issue`/`pr`/`repo` verbs via the scout door
 *     (door-kit → scoutd), where the real request is governed (`github-budget`)
 *     and content-addressed + invalidated (`cas` + `anchored-chain`).
 *
 * IMPORTANT: this repo does NOT cache. Caching belongs to the layer behind the
 * scout door (cas/anchored-chain); `directReads` is a thin pass-through. See
 * docs/reads-through-scout.md.
 */

import {
  boardItems,
  existingContentIds,
  getProject,
  orgMergedPullRequests,
  orgOpenWorkItems,
  orgRepos,
} from "./projects.ts";

/**
 * The board read-port — the set of read-only GitHub queries this repo needs.
 * Signatures are borrowed (`typeof`) from the concrete client so the port and
 * the default adapter can never disagree on shape.
 */
export interface BoardReads {
  /** The Front Desk project (id, title, fields). */
  readonly getProject: typeof getProject;
  /** All items on the board with their field values. */
  readonly boardItems: typeof boardItems;
  /** Every open issue/PR across all org repos (+ unreadable repos skipped). */
  readonly orgOpenWorkItems: typeof orgOpenWorkItems;
  /** Merged PRs across all org repos (traceability). */
  readonly orgMergedPullRequests: typeof orgMergedPullRequests;
  /** Content ids already on the board (for the add sweep). */
  readonly existingContentIds: typeof existingContentIds;
  /** All org repos (for linking the project tab). */
  readonly orgRepos: typeof orgRepos;
}

/**
 * The default adapter: pass straight through to the Projects v2 client. No
 * caching, no provenance — that's the scout door's job when a scout adapter is
 * injected in place of this one.
 */
export const directReads: BoardReads = {
  getProject,
  boardItems,
  orgOpenWorkItems,
  orgMergedPullRequests,
  existingContentIds,
  orgRepos,
};
