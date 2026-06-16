/**
 * Front Desk contract — the single source of truth for the org project board.
 *
 * This supersedes the `gh api graphql` bash snippets in
 * `docs/beads-projection.md`. The board's schema (the fields the room applies,
 * their options, and how they map to beads) lives HERE, as data, so the
 * `gh-project-room` process can reconcile the live board to it idempotently.
 *
 * "core/epic business-behavior contract layer in one place" → this file.
 *
 * Hotel framing (see docs/org-map.md → Naming convention):
 *   - gh-project-room is a ROOM (a process): it runs sync/apply.
 *   - It acts through a DOOR: the `Organization Projects: read+write` capability
 *     bundle (+ repo issues/PRs read), granted to a signed GitHub App.
 *   - A GUEST (the schedule, a maintainer dispatch, or a per-repo event) triggers it.
 *   - This module is the CONTRACT the room applies through that door.
 *
 * Pure data + types only — no I/O, no side effects. ESM, explicit return types
 * (JSR "no slow types"), so it lifts cleanly into a standalone published package
 * (`@bounded-systems/gh-project-room`) when it graduates — see
 * `docs/handoffs/gh-project-room.md`.
 */

/** The org that owns Front Desk. */
export const ORG = "bounded-systems" as const;

/** Front Desk is org project #2 (see docs/org-map.md). */
export const PROJECT_NUMBER = 2 as const;

/** Single-select option colors are a fixed GraphQL enum in Projects v2. */
export type SingleSelectColor =
  | "RED"
  | "ORANGE"
  | "YELLOW"
  | "GREEN"
  | "BLUE"
  | "PURPLE"
  | "PINK"
  | "GRAY";

/** One option of a single-select field. `description` is required by the API. */
export interface SingleSelectOption {
  readonly name: string;
  readonly color: SingleSelectColor;
  readonly description: string;
}

/** A single-select custom field (e.g. Type, Status). */
export interface SingleSelectFieldSpec {
  readonly kind: "SINGLE_SELECT";
  readonly name: string;
  /** If true, Projects v2 provides this field by default — reconcile, don't create. */
  readonly builtIn: boolean;
  readonly options: readonly SingleSelectOption[];
}

/** A free-text custom field (e.g. "Depends on"). */
export interface TextFieldSpec {
  readonly kind: "TEXT";
  readonly name: string;
  readonly builtIn: boolean;
}

export type FieldSpec = SingleSelectFieldSpec | TextFieldSpec;

/**
 * `Type` — the nature of a work item. Mirrors the beads custom schema
 * (room/door/task) and adds `epic`: a parent issue whose native sub-issues are
 * the work. The epic IS the business-behavior contract.
 */
export const TYPE_FIELD: SingleSelectFieldSpec = {
  kind: "SINGLE_SELECT",
  name: "Type",
  builtIn: false,
  options: [
    {
      name: "epic",
      color: "YELLOW",
      description:
        "Business-behavior contract: a parent issue whose sub-issues are the work.",
    },
    { name: "room", color: "BLUE", description: "A process — a bounded, running execution context." },
    { name: "door", color: "PURPLE", description: "A set of capabilities a room acts through." },
    { name: "task", color: "GRAY", description: "Ordinary work item." },
  ],
};

/**
 * `Status` — built-in single-select. Projects v2 ships Todo / In Progress / Done
 * by default; we also want `Blocked`. The room reconciles missing options where
 * the GraphQL surface allows, and otherwise reports them for a one-time UI add
 * (adding options to an existing field has no clean mutation — see the client).
 *
 * beads mapping: Todo=open, In progress=in_progress, Blocked=blocked, Done=closed.
 * `bd ready` = open with no open blockers.
 */
export const STATUS_FIELD: SingleSelectFieldSpec = {
  kind: "SINGLE_SELECT",
  name: "Status",
  builtIn: true,
  options: [
    { name: "Todo", color: "GRAY", description: "Open, not started (bead: open)." },
    { name: "In progress", color: "BLUE", description: "Being worked (bead: in_progress)." },
    {
      name: "Blocked",
      color: "RED",
      description: "Has an open blocker (bead: blocked; excluded from `bd ready`).",
    },
    { name: "Done", color: "GREEN", description: "Closed or merged (bead: closed)." },
  ],
};

/**
 * `Depends on` — free text carrying the `blocks` edges that aren't native
 * parent-child sub-issues (e.g. #9 → "Depends on: #6, #7, #8"). See
 * docs/beads-projection.md for the edge model.
 */
export const DEPENDS_ON_FIELD: TextFieldSpec = {
  kind: "TEXT",
  name: "Depends on",
  builtIn: false,
};

/**
 * Native fields the board uses but the room never creates:
 *   - `Milestone` — native issue/PR attribute (release / time-box); group & filter by it.
 *   - parent / sub-issues — native; carries Epic → children (beads `parent-child`).
 * Listed here for documentation; not part of the reconcile set.
 */
export const NATIVE_FIELDS = ["Milestone", "Parent issue"] as const;

/** The full set of fields the room reconciles the live board against. */
export const FRONT_DESK_FIELDS: readonly FieldSpec[] = [
  TYPE_FIELD,
  STATUS_FIELD,
  DEPENDS_ON_FIELD,
];

/** What lands on the board automatically. Draft issues are never auto-added. */
export const TRACKED_CONTENT: readonly ("Issue" | "PullRequest")[] = [
  "Issue",
  "PullRequest",
];
