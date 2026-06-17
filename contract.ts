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

/** A number custom field (e.g. "Effort", "Value"). */
export interface NumberFieldSpec {
  readonly kind: "NUMBER";
  readonly name: string;
  readonly builtIn: boolean;
}

export type FieldSpec =
  | SingleSelectFieldSpec
  | TextFieldSpec
  | DateFieldSpec
  | NumberFieldSpec;

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
    {
      name: "room",
      color: "BLUE",
      description: "A process — a bounded, running execution context.",
    },
    {
      name: "door",
      color: "PURPLE",
      description: "A set of capabilities a room acts through.",
    },
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
    {
      name: "Todo",
      color: "GRAY",
      description: "Open, not started (bead: open).",
    },
    {
      name: "In progress",
      color: "BLUE",
      description: "Being worked (bead: in_progress).",
    },
    {
      name: "Blocked",
      color: "RED",
      description:
        "Has an open blocker (bead: blocked; excluded from `bd ready`).",
    },
    {
      name: "Done",
      color: "GREEN",
      description: "Closed or merged (bead: closed).",
    },
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

/**
 * `Start date` / `Target date` — DATE fields that power the Roadmap view (#78).
 *
 * The Roadmap renders each item as a bar spanning Start date → Target date; with
 * only one set, the item shows as a point. The `Roadmap` ViewSpec already points
 * at `"Start date and Target date"`, so these fields must exist for it to render.
 *
 * Unlike views and insights, DATE fields have a clean `createProjectV2Field`
 * mutation, so the sweep creates them like any other custom field. They
 * complement the native `Milestone` (release grouping) with an explicit per-item
 * planning window. Assigning the actual dates/milestones to items remains a
 * manual/operational step — see #78.
 */
export const START_DATE_FIELD: DateFieldSpec = {
  kind: "DATE",
  name: "Start date",
  builtIn: false,
};

export const TARGET_DATE_FIELD: DateFieldSpec = {
  kind: "DATE",
  name: "Target date",
  builtIn: false,
};

/**
 * `Effort` — abstract effort-point estimate for `prioritization.ts`.
 *
 * Read by the prioritizer as `PriorityInput.effort` (EffortPoints). Treated as 1
 * when 0 or unset inside `score()` to guard against divide-by-zero. Units are
 * deliberately abstract — see `ConversionMapping` in prioritization.ts.
 */
export const EFFORT_FIELD: NumberFieldSpec = {
  kind: "NUMBER",
  name: "Effort",
  builtIn: false,
};

/**
 * `Value` — business value / urgency estimate, 0–100.
 *
 * Higher = more worth doing now. Read by the prioritizer as `PriorityInput.value`;
 * drives value-density (value / effort) in the composite score.
 */
export const VALUE_FIELD: NumberFieldSpec = {
  kind: "NUMBER",
  name: "Value",
  builtIn: false,
};

/**
 * `Score` — composite priority score written back by the sweep (#7).
 *
 * Computed by `score()` in prioritization.ts from Effort, Value, and the
 * "Depends on" edge graph. Eligible items (open/in-progress, no open blockers)
 * receive a non-zero score; ineligible items score 0 and sort to the bottom.
 * Updated on every sweep only when the value changes (anti-thrash guard).
 */
export const SCORE_FIELD: NumberFieldSpec = {
  kind: "NUMBER",
  name: "Score",
  builtIn: false,
};

/** The full set of fields the room reconciles the live board against. */
export const FRONT_DESK_FIELDS: readonly FieldSpec[] = [
  TYPE_FIELD,
  STATUS_FIELD,
  DEPENDS_ON_FIELD,
  START_DATE_FIELD,
  TARGET_DATE_FIELD,
  EFFORT_FIELD,
  VALUE_FIELD,
  SCORE_FIELD,
];

/**
 * Classify a work item into a `Kind` option on first add (#51).
 *
 * Deterministic and label-first, so a maintainer can always override the guess
 * by labelling the issue:
 *   1. An explicit kind label (`epic`/`room`/`door`/`task`) wins.
 *   2. An issue that has native sub-issues is an `epic` — it's a parent
 *      business-behavior contract whose children are the work.
 *   3. Everything else — PRs and leaf issues — defaults to `task`.
 *
 * Returns one of `TYPE_FIELD`'s option names. The sweep only calls this for
 * items it is adding, so manually-set Kind values on existing items are never
 * touched (the re-run idempotency requirement in #51).
 */
export function classifyKind(
  item: {
    readonly kind: "Issue" | "PullRequest";
    readonly labels: readonly string[];
    readonly hasSubIssues: boolean;
  },
): string {
  const known = new Set(TYPE_FIELD.options.map((o) => o.name));
  for (const label of item.labels) {
    const name = label.toLowerCase();
    if (known.has(name)) return name;
  }
  if (item.kind === "Issue" && item.hasSubIssues) return "epic";
  return "task";
}

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
    name: "Ready (ranked)",
    layout: "TABLE",
    filter: "status:Todo no:depends-on",
    sortBy: "Score",
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
  /**
   * The action configured on this workflow in the UI (e.g. "Set value").
   * Documentation-only — the API exposes enabled state but not action config.
   */
  readonly action?: string;
  /**
   * The field=value the action sets (e.g. "Status: Todo").
   * Documentation-only — mirrors the UI "Set value" action.
   */
  readonly setValue?: string;
}

/**
 * The built-in workflows and their desired state on Front Desk.
 *
 * IMPORTANT: Only the 6 workflows below are exposed by the GraphQL
 * `projectV2Workflows` query. The remaining 5 appear in the GitHub Projects UI
 * but are NOT returned by the API — see `FRONT_DESK_WORKFLOWS_UI_ONLY` below.
 *
 * Status automation pipeline (the four enabled Set-value workflows):
 *   item added          → Status: Todo       (item lands, not yet started)
 *   PR linked to issue  → Status: In Progress (work has begun)
 *   item closed         → Status: Done        (closed/merged)
 *   PR merged           → Status: Done        (merge path)
 *
 * Auto-add sub-issues: no action — just adds sub-issues to the board.
 * Auto-close issue: disabled — not yet wired.
 */
export const FRONT_DESK_WORKFLOWS: readonly WorkflowSpec[] = [
  { name: "Auto-add sub-issues to project", enabled: true },
  { name: "Auto-close issue", enabled: false },
  {
    name: "Item added to project",
    enabled: true,
    action: "Set value",
    setValue: "Status: Todo",
  },
  {
    name: "Item closed",
    enabled: true,
    action: "Set value",
    setValue: "Status: Done",
  },
  {
    name: "Pull request linked to issue",
    enabled: true,
    action: "Set value",
    setValue: "Status: In Progress",
  },
  {
    name: "Pull request merged",
    enabled: true,
    action: "Set value",
    setValue: "Status: Done",
  },
];

/**
 * Built-in workflow names that appear in the GitHub Projects UI (Workflows tab)
 * but are NOT returned by the `projectV2Workflows` GraphQL query. The sweep
 * cannot check or toggle these — manage them manually via the UI.
 *
 * Desired state:
 *   - Auto-add to project: DISABLED — our sweep (orgOpenWorkItems) handles this.
 *   - Auto-archive items: DISABLED — we want closed items visible (Status=Done).
 *   - Code changes requested, Code review approved, Item reopened: DISABLED —
 *     not yet wired; revisit when Status automation is fuller.
 */
export const FRONT_DESK_WORKFLOWS_UI_ONLY: readonly string[] = [
  "Auto-add to project",
  "Auto-archive items",
  "Code changes requested",
  "Code review approved",
  "Item reopened",
];

/**
 * Insights charts are UI-only — GitHub Projects v2 exposes no GraphQL
 * mutations to create or configure them. Document the desired charts here
 * for drift-detection; the sweep reports MISSING for manual action.
 *
 * Default charts (always present): Burn up.
 * Custom charts: add via Front Desk → Insights → + New chart.
 *
 * Field names match the GitHub Projects v2 UI exactly:
 *   Layout: Bar | Column | Line | Stacked area | Stacked bar | Stacked column
 *   X-axis: any field name (Status, Kind, Milestone, …)
 *   Group by: any field name (creates stacked/grouped segments)
 *   Y-axis: Count of items | Sum/Average/Min/Max of a field
 */
export type InsightLayout =
  | "BURN_UP"
  | "BAR"
  | "COLUMN"
  | "LINE"
  | "STACKED_AREA"
  | "STACKED_BAR"
  | "STACKED_COLUMN";

export type InsightYAxis = "COUNT" | "SUM" | "AVERAGE" | "MIN" | "MAX";

export interface InsightChartSpec {
  readonly name: string;
  readonly layout: InsightLayout;
  /** X-axis field (UI label). Not used for BURN_UP (built-in). */
  readonly xAxis?: string;
  /** Optional grouping field — creates stacked/grouped segments. */
  readonly groupBy?: string;
  /** Y-axis aggregation (default: COUNT). */
  readonly yAxis?: InsightYAxis;
  /** Field to aggregate when yAxis is SUM/AVERAGE/MIN/MAX. */
  readonly yAxisField?: string;
  /** Filter query — same syntax as the UI search bar. */
  readonly filter?: string;
}

/**
 * The desired Insights charts on Front Desk.
 *
 * Burn up — built-in default; tracks total vs completed over time.
 * Status snapshot — current board state at a glance (what's moving?).
 * Work by Kind — type distribution + health in one view (what are we building?).
 * Milestone progress — per-release completion tracking (are we on track?).
 */
export const FRONT_DESK_INSIGHTS: readonly InsightChartSpec[] = [
  {
    name: "Burn up",
    layout: "BURN_UP",
    filter: "is:issue",
  },
  {
    name: "Status snapshot",
    layout: "COLUMN",
    xAxis: "Status",
    yAxis: "COUNT",
  },
  {
    name: "Work by Kind",
    layout: "STACKED_COLUMN",
    xAxis: "Kind",
    groupBy: "Status",
    yAxis: "COUNT",
  },
  {
    name: "Milestone progress",
    layout: "STACKED_COLUMN",
    xAxis: "Milestone",
    groupBy: "Status",
    yAxis: "COUNT",
    filter: "is:issue",
  },
];

/**
 * Beads→GitHub projection map.
 *
 * beads is the canonical origin for work-item state; GitHub Projects (Front Desk)
 * is a projection. Not all projections are implemented yet — gaps appear as
 * "No Kind", "No Milestone", etc. in the Insights charts and as empty custom
 * fields on the board.
 *
 * beads edge types (see docs/beads-projection.md for the live edge graph):
 *   parent-child    — GitHub native sub-issues (already projected)
 *   blocks          — "Depends on" field (field exists, not yet populated from beads)
 *   related         — no GitHub surface yet
 *   discovered-from — no GitHub surface yet
 */
export interface BeadsProjectionSpec {
  /** The beads concept being projected. */
  readonly beadsConcept: string;
  /** The GitHub Projects v2 field or mechanism that carries it. */
  readonly ghField: string;
  /** Whether this projection is currently populated on the board. */
  readonly projected: boolean;
  /**
   * What populates this field today, or what tracking issue covers
   * implementing it.
   */
  readonly notes: string;
}

/**
 * The full beads→Front Desk projection map.
 *
 * Items with `projected: false` explain the empty chart segments:
 *   "No Kind"      → #51 (auto-set Kind on item add)
 *   "No Milestone" → #78 (create milestones, set date fields on epics)
 */
export const BEADS_PROJECTIONS: readonly BeadsProjectionSpec[] = [
  {
    beadsConcept: "state (open / in_progress / blocked / closed)",
    ghField: "Status",
    projected: true,
    notes:
      "Lifecycle workflows: item added→Todo, PR linked→In Progress, closed/merged→Done. bd ready = Todo with no open Depends on.",
  },
  {
    beadsConcept: "type (epic / room / door / task)",
    ghField: "Kind",
    projected: false,
    notes:
      "Pending #51 — auto-set Kind when item lands. Charts show 'No Kind' until implemented.",
  },
  {
    beadsConcept: "blocks edges (non-parent dependency)",
    ghField: "Depends on",
    projected: false,
    notes:
      "Field exists; not yet written from beads. Manual free-text workaround only. Structured edge projection TBD.",
  },
  {
    beadsConcept: "parent-child (epic → sub-issues)",
    ghField: "Parent issue (native)",
    projected: true,
    notes:
      "Native GitHub sub-issues. Auto-add sub-issues workflow lands children on the board automatically.",
  },
  {
    beadsConcept: "release / time-box",
    ghField: "Milestone (native)",
    projected: false,
    notes:
      "Pending #78 — create milestones, set Start/Target date fields on epics. Charts show 'No Milestone' until done.",
  },
  {
    beadsConcept: "related, discovered-from edges",
    ghField: "(none)",
    projected: false,
    notes:
      "No GitHub Projects surface for these edge types. Tracked in docs/beads-projection.md for future beads export.",
  },
];

// ---------------------------------------------------------------------------
// Bead work-item schema — TypeScript types (compile-time contract).
// Runtime validation lives in schema.ts (Zod). Both must stay in sync.
// ---------------------------------------------------------------------------

/** Work-item kind. Maps to the Kind field on Front Desk. */
export type BeadKind = "epic" | "room" | "door" | "task";

/**
 * Lifecycle state. Maps to Status on Front Desk:
 *   open → Todo, in_progress → In Progress, blocked → Blocked, closed → Done.
 * `bd ready` = open with no open `blocks` edges.
 */
export type BeadState = "open" | "in_progress" | "blocked" | "closed";

/** Edge type in the beads dependency graph. */
export type BeadEdgeType =
  | "parent-child"
  | "blocks"
  | "related"
  | "discovered-from";

/** A single directed edge. `targetNumber` is the GitHub issue number. */
export interface BeadEdge {
  readonly type: BeadEdgeType;
  readonly targetNumber: number;
}

/**
 * A complete beads work item — the shape required for a valid projection to
 * Front Desk. Missing any of these fields is why charts show "No Kind" or
 * "No Milestone".
 *
 * `milestone` is optional (unscheduled work is valid); all other fields are
 * required. Validate instances with `BeadWorkItemSchema` in schema.ts before
 * projection.
 */
export interface BeadWorkItem {
  /** GitHub issue number — the stable cross-system key. */
  readonly number: number;
  readonly title: string;
  /** Required — absence produces "No Kind" in Insights. */
  readonly kind: BeadKind;
  /** Required — drives Status automation. */
  readonly state: BeadState;
  /** Optional — unscheduled work is valid; absence produces "No Milestone". */
  readonly milestone?: string;
  /** All dependency/relationship edges for this item. */
  readonly edges: readonly BeadEdge[];
}
