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

/** A date custom field (e.g. "Start date", "Target date"). */
export interface DateFieldSpec {
  readonly kind: "DATE";
  readonly name: string;
  readonly builtIn: boolean;
}

export type FieldSpec = SingleSelectFieldSpec | TextFieldSpec | DateFieldSpec;

/**
 * `Kind` — the nature of a work item. Mirrors the beads custom schema
 * (room/door/task) and adds `epic`: a parent issue whose native sub-issues are
 * the work. The epic IS the business-behavior contract.
 *
 * Named "Kind" not "Type": GitHub Projects v2 reserves "Type" as a built-in
 * field name ("Item type"), so createProjectV2Field rejects it.
 */
export const TYPE_FIELD: SingleSelectFieldSpec = {
  kind: "SINGLE_SELECT",
  name: "Kind",
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

export type ViewLayout = "TABLE" | "BOARD" | "ROADMAP";

/**
 * A Projects v2 view spec. GitHub's API has no create/update view mutations
 * so these are documentation + drift-detection only — the sweep reports
 * missing views as manual action items (add via UI → + New view).
 *
 * Field names match the GitHub Projects v2 UI exactly.
 *
 * Table-specific:   `groupBy`, `sortBy`, `sliceBy`, `showHierarchy`
 * Board-specific:   `columnBy` (columns), `swimlanes` (rows), `fieldSum`,
 *                   `sliceBy` (separate sub-boards)
 * Roadmap-specific: `dates` ("Start date and Target date"), `zoomLevel`,
 *                   `markers`, `sliceBy`
 */
export interface ViewSpec {
  readonly name: string;
  readonly layout: ViewLayout;
  /** Filter query — same syntax as the UI search bar. */
  readonly filter?: string;
  /** Table: group rows. */
  readonly groupBy?: string;
  /** Table/Roadmap: sort order. */
  readonly sortBy?: string;
  /** All layouts: split into separate sub-views. */
  readonly sliceBy?: string;
  /** Table: nest sub-issues under their parent. */
  readonly showHierarchy?: boolean;
  /** Board: field that defines columns (default: Status). */
  readonly columnBy?: string;
  /** Board: field that defines swimlane rows. */
  readonly swimlanes?: string;
  /** Board: field to sum in column footers (e.g. "Count"). */
  readonly fieldSum?: string;
  /** Roadmap: date range fields shown as bars (e.g. "Start date and Target date"). */
  readonly dates?: string;
  /** Roadmap: zoom granularity (e.g. "Month"). */
  readonly zoomLevel?: string;
  /** Roadmap: milestone/iteration field shown as vertical marker lines. */
  readonly markers?: string;
}

/**
 * The named views on Front Desk.
 * Daily planning loop: Ready → Board → Blocked.
 * Navigation: Epics, Roadmap.
 * Default: Lobby (all open items).
 */
export const FRONT_DESK_VIEWS: readonly ViewSpec[] = [
  {
    name: "Lobby",
    layout: "TABLE",
    filter: "-status:Blocked -status:Done",
    sortBy: "Status",
    showHierarchy: true,
  },
  {
    name: "Ready",
    layout: "TABLE",
    filter: "status:Todo no:depends-on",
    sliceBy: "Kind",
  },
  {
    name: "Board",
    layout: "BOARD",
    columnBy: "Status",
    swimlanes: "Milestone",
  },
  {
    name: "Epics",
    layout: "TABLE",
    filter: "kind:epic",
    groupBy: "Milestone",
    showHierarchy: true,
  },
  {
    name: "Blocked",
    layout: "TABLE",
    filter: "status:Blocked",
    sortBy: "Status",
  },
  {
    name: "Roadmap",
    layout: "ROADMAP",
    dates: "Start date and Target date",
    zoomLevel: "Month",
  },
];

/**
 * Built-in workflow spec for Projects v2.
 *
 * GitHub exposes these via the `projectV2Workflows` GraphQL connection.
 * The `updateProjectV2Workflow` mutation can enable/disable them — the sweep
 * reconciles `enabled` state idempotently.
 *
 * `name` must match the GitHub UI label exactly (case-sensitive).
 */
export interface WorkflowSpec {
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * The built-in workflows and their desired state on Front Desk.
 *
 * Enabled:
 *   - Auto-add sub-issues: sub-issues of tracked epics land on the board automatically.
 *   - Item closed: sets Status → Done when an issue/PR is closed (see #52).
 *   - Item added to project: fires when any item lands; used for auto-Kind assignment (#51).
 *   - Pull request merged: fires on merge; keeps Status in sync.
 *   - Pull request linked to issue: surfaces PR↔issue relationships.
 *
 * Disabled:
 *   - Auto-add to project: our sweep (orgOpenWorkItems) handles this more precisely.
 *   - Auto-archive items: we want closed items to stay visible (Status=Done, not archived).
 *   - Auto-close issue, Code changes requested, Code review approved, Item reopened:
 *     not yet wired — revisit when Status automation is fuller.
 */
export const FRONT_DESK_WORKFLOWS: readonly WorkflowSpec[] = [
  { name: "Auto-add sub-issues to project", enabled: true },
  { name: "Item closed",                    enabled: true },
  { name: "Item added to project",          enabled: true },
  { name: "Pull request merged",            enabled: true },
  { name: "Pull request linked to issue",   enabled: true },
  { name: "Auto-add to project",            enabled: false },
  { name: "Auto-archive items",             enabled: false },
  { name: "Auto-close issue",               enabled: false },
  { name: "Code changes requested",         enabled: false },
  { name: "Code review approved",           enabled: false },
  { name: "Item reopened",                  enabled: false },
];

/**
 * Insights charts are UI-only — GitHub Projects v2 exposes no GraphQL
 * mutations to create or configure them. Document the desired charts here
 * for drift-detection; the sweep reports MISSING for manual action.
 *
 * Default charts (always present): Burn up.
 * Custom charts: add via Front Desk → Insights → + New chart.
 */
export interface InsightChartSpec {
  readonly name: string;
  readonly type: "BURN_UP" | "BURN_DOWN" | "STACKED_AREA" | "COLUMN" | "LINE";
  /** GraphQL filter string — same syntax as the UI search bar. */
  readonly filter?: string;
}

export const FRONT_DESK_INSIGHTS: readonly InsightChartSpec[] = [
  { name: "Burn up",            type: "BURN_UP",       filter: "is:issue" },
  { name: "Status breakdown",   type: "STACKED_AREA",  filter: "is:issue" },
  { name: "Cycle time",         type: "COLUMN",        filter: "is:issue status:Done" },
];
