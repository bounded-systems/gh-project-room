/**
 * Runtime validation for beads work items — the Zod half of the type contract.
 *
 * TypeScript types (compile-time) live in contract.ts. This file provides
 * runtime schemas that validate the same shapes so projection code can catch
 * missing fields (kind, milestone, edges) before they silently produce empty
 * chart segments ("No Kind", "No Milestone") on Front Desk.
 *
 * Usage:
 *   import { BeadWorkItemSchema } from "./schema.ts";
 *   const item = BeadWorkItemSchema.parse(raw);        // throws ZodError on invalid
 *   const result = BeadWorkItemSchema.safeParse(raw);  // returns {success, data/error}
 *
 * Inferred output type (z.infer<typeof BeadWorkItemSchema>) is structurally
 * identical to the BeadWorkItem interface in contract.ts.
 */

import { z } from "zod";
import type {
  BeadEdge,
  BeadEdgeType,
  BeadKind,
  BeadState,
  FieldSpec,
  SingleSelectColor,
  SingleSelectOption,
  ViewLayout,
  ViewSpec,
  WorkflowSpec,
} from "./contract.ts";

export const BeadKindSchema: z.ZodType<BeadKind> = z.enum([
  "epic",
  "room",
  "door",
  "task",
]);

export const BeadStateSchema: z.ZodType<BeadState> = z.enum([
  "open",
  "in_progress",
  "blocked",
  "closed",
]);

export const BeadEdgeTypeSchema: z.ZodType<BeadEdgeType> = z.enum([
  "parent-child",
  "blocks",
  "related",
  "discovered-from",
]);

export const BeadEdgeSchema: z.ZodType<BeadEdge> = z.object({
  type: BeadEdgeTypeSchema,
  targetNumber: z.number().int().positive(),
});

/**
 * Validates a complete beads work item.
 *
 * `kind` and `state` are required enums — missing either is a hard error.
 * `milestone` is optional (unscheduled work is valid).
 * `edges` defaults to [] so items with no dependencies parse without the field.
 *
 * The inferred output type is structurally identical to BeadWorkItem in
 * contract.ts. The explicit annotation is omitted because .default([]) on
 * `edges` widens the input type, which would conflict with ZodType<BeadWorkItem>.
 */
export const BeadWorkItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  kind: BeadKindSchema,
  state: BeadStateSchema,
  milestone: z.string().min(1).optional(),
  edges: z.array(BeadEdgeSchema).readonly().default([]),
});

export type BeadWorkItemInput = z.input<typeof BeadWorkItemSchema>;
export type BeadWorkItemOutput = z.output<typeof BeadWorkItemSchema>;

// ---------------------------------------------------------------------------
// Board-schema (Front Desk fields/views/workflows) — the Zod half of the
// contract.ts types above the beads projection. Lets verbs.ts (and any future
// VerbSpec consumer) validate a FieldSpec/ViewSpec/WorkflowSpec at runtime
// instead of trusting the TypeScript types alone.
// ---------------------------------------------------------------------------

export const SingleSelectColorSchema: z.ZodType<SingleSelectColor> = z.enum([
  "RED",
  "ORANGE",
  "YELLOW",
  "GREEN",
  "BLUE",
  "PURPLE",
  "PINK",
  "GRAY",
]);

export const SingleSelectOptionSchema: z.ZodType<SingleSelectOption> = z
  .object({
    name: z.string(),
    color: SingleSelectColorSchema,
    description: z.string(),
  });

/** Mirrors contract.ts's `FieldSpec` union (SingleSelect/Text/Date/Number). */
export const FieldSpecSchema: z.ZodType<FieldSpec> = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("SINGLE_SELECT"),
      name: z.string(),
      builtIn: z.boolean(),
      options: z.array(SingleSelectOptionSchema),
    }),
    z.object({
      kind: z.literal("TEXT"),
      name: z.string(),
      builtIn: z.boolean(),
    }),
    z.object({
      kind: z.literal("DATE"),
      name: z.string(),
      builtIn: z.boolean(),
    }),
    z.object({
      kind: z.literal("NUMBER"),
      name: z.string(),
      builtIn: z.boolean(),
    }),
  ],
);

export const ViewLayoutSchema: z.ZodType<ViewLayout> = z.enum([
  "TABLE",
  "BOARD",
  "ROADMAP",
]);

/** Mirrors contract.ts's `ViewSpec` — a Front Desk view (Table/Board/Roadmap). */
export const ViewSpecSchema: z.ZodType<ViewSpec> = z.object({
  name: z.string(),
  layout: ViewLayoutSchema,
  filter: z.string().optional(),
  groupBy: z.string().optional(),
  sortBy: z.string().optional(),
  sliceBy: z.string().optional(),
  showHierarchy: z.boolean().optional(),
  columnBy: z.string().optional(),
  swimlanes: z.string().optional(),
  fieldSum: z.string().optional(),
  dates: z.string().optional(),
  zoomLevel: z.string().optional(),
  markers: z.string().optional(),
});

/** Mirrors contract.ts's `WorkflowSpec` — a built-in Projects v2 workflow. */
export const WorkflowSpecSchema: z.ZodType<WorkflowSpec> = z.object({
  name: z.string(),
  enabled: z.boolean(),
  action: z.string().optional(),
  setValue: z.string().optional(),
});
