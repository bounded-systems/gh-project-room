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

import { z } from "npm:zod@3";
import type { BeadEdge, BeadEdgeType, BeadKind, BeadState } from "./contract.ts";

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
