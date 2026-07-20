import { assertEquals } from "@std/assert";
import {
  boardItemsToInputs,
  parseDependsOn,
  statusToBeadState,
} from "./board-inputs.ts";
import type { BoardItem, BoardItemFields } from "./projects.ts";

function boardItem(
  overrides: Partial<Omit<BoardItem, "fields">> & {
    fields?: Partial<BoardItemFields>;
  } = {},
): BoardItem {
  const { fields, ...rest } = overrides;
  return {
    itemId: "item-1",
    contentId: "content-1",
    number: 1,
    repo: "gh-project-room",
    isPrivate: false,
    ghState: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    ...rest,
    fields: {
      status: "Todo",
      kind: "task",
      effort: null,
      value: null,
      dependsOn: null,
      score: null,
      ...fields,
    },
  };
}

Deno.test("parseDependsOn: extracts #N references, tolerates null", () => {
  assertEquals(parseDependsOn(null), []);
  assertEquals(parseDependsOn(""), []);
  assertEquals(parseDependsOn("#1 blocks #2"), [1, 2]);
  assertEquals(parseDependsOn("depends on #42"), [42]);
});

Deno.test("statusToBeadState: maps Projects Status to BeadState", () => {
  assertEquals(statusToBeadState("In progress"), "in_progress");
  assertEquals(statusToBeadState("Blocked"), "blocked");
  assertEquals(statusToBeadState("Done"), "closed");
  assertEquals(statusToBeadState("Todo"), "open");
  assertEquals(statusToBeadState(null), "open");
});

Deno.test("boardItemsToInputs: preserves order and defaults kind to task", () => {
  const inputs = boardItemsToInputs([
    boardItem({ number: 7, fields: { kind: null } }),
    boardItem({ number: 8, fields: { kind: "epic" } }),
  ]);
  assertEquals(inputs.map((i) => i.number), [7, 8]);
  assertEquals(inputs[0].kind, "task");
  assertEquals(inputs[1].kind, "epic");
  assertEquals(inputs[0].title, "#7");
});

Deno.test("boardItemsToInputs: computes openBlockers and unblocks from deps", () => {
  const inputs = boardItemsToInputs([
    boardItem({ number: 1, fields: { status: "Todo" } }),
    boardItem({ number: 2, fields: { status: "Todo", dependsOn: "#1" } }),
    // A Done item's dependency edges are not counted as live leverage.
    boardItem({ number: 3, fields: { status: "Done", dependsOn: "#1" } }),
  ]);
  const byNum = new Map(inputs.map((i) => [i.number, i]));
  // #2 depends on #1, which is not Done -> one open blocker.
  assertEquals(byNum.get(2)!.openBlockers, 1);
  // #1 is unblocked only by the live #2; #3 is Done so its edge is skipped.
  assertEquals(byNum.get(1)!.unblocks, 1);
});
