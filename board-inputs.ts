/**
 * @module
 * Projection from board items (`projects.ts`) to prioritizer inputs
 * (`prioritization.ts`). This is the single code path that both `sync.ts`'s
 * Score write-back and `ready.ts`'s ranked queue use, so the two can never
 * drift on how a board item becomes a Score.
 *
 * Kept out of `prioritization.ts` (pure/JSR — must not import `BoardItem`) and
 * out of `projects.ts` (the GraphQL client); a small module depending on both
 * is the clean seam.
 */

import type { BeadKind, BeadState } from "./contract.ts";
import type { PriorityInput } from "./prioritization.ts";
import type { BoardItem } from "./projects.ts";

/** Parse "#N" references out of a "Depends on" text field value. */
export function parseDependsOn(text: string | null): number[] {
  if (!text) return [];
  return (text.match(/#(\d+)/g) ?? []).map((m) => parseInt(m.slice(1), 10));
}

/** Map a Projects v2 Status option name to a BeadState. */
export function statusToBeadState(status: string | null): BeadState {
  if (status === "In progress") return "in_progress";
  if (status === "Blocked") return "blocked";
  if (status === "Done") return "closed";
  return "open";
}

/**
 * Project every board item to a `PriorityInput` in one pass: builds the status
 * lookup and the reverse-dependency (`unblocks`) map, then computes
 * `openBlockers` per item and assembles each input. Pure — data in, inputs out,
 * no network. Order is preserved (inputs[i] corresponds to items[i]) so callers
 * can index-align back to the source `BoardItem` for `itemId` / current Score.
 */
export function boardItemsToInputs(
  items: readonly BoardItem[],
): PriorityInput[] {
  // Build a status lookup and a reverse-dependency count in one pass.
  const statusByNumber = new Map<number, string | null>(
    items.map((i) => [i.number, i.fields.status]),
  );
  const unblocksCounts = new Map<number, number>();
  for (const item of items) {
    if (item.fields.status === "Done") continue;
    for (const dep of parseDependsOn(item.fields.dependsOn)) {
      unblocksCounts.set(dep, (unblocksCounts.get(dep) ?? 0) + 1);
    }
  }

  return items.map((item) => {
    const deps = parseDependsOn(item.fields.dependsOn);
    // A dependency is still open unless it's on the board and marked Done.
    const openBlockers = deps.filter(
      (dep) => statusByNumber.get(dep) !== "Done",
    ).length;
    return {
      number: item.number,
      title: `#${item.number}`,
      kind: (item.fields.kind as BeadKind | null) ?? "task",
      state: statusToBeadState(item.fields.status),
      effort: item.fields.effort ?? 0,
      value: item.fields.value ?? 0,
      openBlockers,
      unblocks: unblocksCounts.get(item.number) ?? 0,
      ageDays: (Date.now() - new Date(item.createdAt).getTime()) /
        (1000 * 60 * 60 * 24),
    } satisfies PriorityInput;
  });
}
