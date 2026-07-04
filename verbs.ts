/**
 * @module
 * VerbSpec projection of gh-project-room's contract-checking functions — the
 * board contract as dispatchable verbs (CLI today; MCP/OpenAPI/Anthropic-tool
 * for free, via the same `VerbSpec`), not just data.
 *
 * Phase 1 of adopting `@bounded-systems/verbspec`. Each verb below wraps an
 * existing, already-pure function from contract.ts/projects.ts — sync.ts
 * keeps calling those functions directly, so the live sweep is unaffected.
 * See docs/org-map.md's `door-sdk` SDK-family slot for where this pattern is
 * headed org-wide next (a separate, later initiative — not this file).
 *
 * Run:  deno run verbs.ts <verb> [flags]
 *       deno run verbs.ts classify-kind --kind Issue --hasSubIssues
 *       deno run verbs.ts check-view --existingViewNames Lobby,Board --spec.name Roadmap --spec.layout ROADMAP
 */

import { z } from "zod";
import {
  defineVerb,
  dispatch,
  type Registry,
  render,
  type VerbSpec,
} from "verbspec";
import { type BeadKind, classifyKind } from "./contract.ts";
import {
  type ExistingWorkflowState,
  type ViewCheckResult,
  viewExists,
  type WorkflowResult,
  workflowStatus,
} from "./projects.ts";
import {
  BeadKindSchema,
  ViewSpecSchema,
  WorkflowSpecSchema,
} from "./schema.ts";

interface ClassifyKindInput {
  readonly kind: "Issue" | "PullRequest";
  readonly labels: readonly string[];
  readonly hasSubIssues: boolean;
}

const ClassifyKindInputSchema: z.ZodType<ClassifyKindInput> = z.object({
  kind: z.enum(["Issue", "PullRequest"]),
  labels: z.array(z.string()).default([]),
  hasSubIssues: z.boolean().default(false),
});

/**
 * classifyKind's declared return type is the wider `string` (see contract.ts)
 * even though every runtime value it produces is one of TYPE_FIELD's option
 * names, which are exactly the four `BeadKind` values — hence the cast.
 */
export const classifyKindVerb: VerbSpec<
  typeof ClassifyKindInputSchema,
  typeof BeadKindSchema
> = defineVerb({
  id: "classify-kind",
  summary:
    "Classify a work item into a Kind option (label-first, sub-issues → epic, else task).",
  actor: "front-desk",
  input: ClassifyKindInputSchema,
  output: BeadKindSchema,
  run: (input) => classifyKind(input) as BeadKind,
});

interface CheckViewInput {
  readonly existingViewNames: readonly string[];
  readonly spec: import("./contract.ts").ViewSpec;
}

const CheckViewInputSchema: z.ZodType<CheckViewInput> = z.object({
  existingViewNames: z.array(z.string()).default([]),
  spec: ViewSpecSchema,
});

const CheckViewOutputSchema: z.ZodType<ViewCheckResult> = z.object({
  view: z.string(),
  action: z.enum(["exists", "missing"]),
});

export const checkViewVerb: VerbSpec<
  typeof CheckViewInputSchema,
  typeof CheckViewOutputSchema
> = defineVerb({
  id: "check-view",
  summary: "Report whether a Front Desk view spec exists on the live board.",
  actor: "front-desk",
  input: CheckViewInputSchema,
  output: CheckViewOutputSchema,
  run: ({ existingViewNames, spec }) => viewExists(existingViewNames, spec),
});

interface CheckWorkflowInput {
  readonly existingWorkflows: readonly ExistingWorkflowState[];
  readonly spec: import("./contract.ts").WorkflowSpec;
}

const CheckWorkflowInputSchema: z.ZodType<CheckWorkflowInput> = z.object({
  existingWorkflows: z.array(
    z.object({ name: z.string(), enabled: z.boolean() }),
  ).default([]),
  spec: WorkflowSpecSchema,
});

const CheckWorkflowOutputSchema: z.ZodType<WorkflowResult> = z
  .discriminatedUnion("action", [
    z.object({ workflow: z.string(), action: z.literal("ok") }),
    z.object({
      workflow: z.string(),
      action: z.literal("drift"),
      live: z.boolean(),
      want: z.boolean(),
    }),
    z.object({ workflow: z.string(), action: z.literal("not-found") }),
  ]);

export const checkWorkflowVerb: VerbSpec<
  typeof CheckWorkflowInputSchema,
  typeof CheckWorkflowOutputSchema
> = defineVerb({
  id: "check-workflow",
  summary:
    "Report whether a Front Desk workflow spec's enabled state matches the live board.",
  actor: "front-desk",
  input: CheckWorkflowInputSchema,
  output: CheckWorkflowOutputSchema,
  run: ({ existingWorkflows, spec }) => workflowStatus(existingWorkflows, spec),
});

/** The dispatchable verb tree for this repo's contract (CLI/MCP/OpenAPI). */
export const VERBS: Registry = {
  "classify-kind": classifyKindVerb,
  "check-view": checkViewVerb,
  "check-workflow": checkWorkflowVerb,
};

if (import.meta.main) {
  const result = await dispatch(VERBS, Deno.args, "deno run verbs.ts");
  if (result.kind === "help") {
    console.log(result.text);
  } else {
    console.log(render(result.output));
  }
}
