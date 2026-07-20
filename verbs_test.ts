import { assert, assertEquals } from "@std/assert";
import { readyVerb, VERBS } from "./verbs.ts";
import type { BoardReads } from "./reads.ts";
import type { BoardItem, BoardItemFields, Project } from "./projects.ts";

/** A read-port slice backed by a fixed in-memory board — no network. */
function fakeReads(
  board: BoardItem[],
): Pick<BoardReads, "getProject" | "boardItems"> {
  const project: Project = {
    id: "PVT_test",
    title: "Front Desk",
    fields: [],
    views: [],
    workflows: [],
  };
  return {
    getProject: () => Promise.resolve(project),
    boardItems: () => Promise.resolve(board),
  };
}

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

Deno.test("VERBS: registers `ready` under the front-desk actor", () => {
  assertEquals(VERBS["ready"]?.actor, "front-desk");
});

Deno.test("ready verb: ranks board items from the injected reader (no network)", async () => {
  const board = [
    boardItem({ number: 1, fields: { status: "Todo", effort: 10, value: 10 } }),
    boardItem({
      number: 2,
      repo: "trellis",
      fields: { status: "Todo", effort: 2, value: 80 },
    }),
    boardItem({ number: 3, fields: { status: "Blocked" } }), // ineligible
  ];
  // Inject reads via deps — the port slice a scout-backed adapter will supply.
  const out = await readyVerb.run({ top: 10 }, { reads: fakeReads(board) });
  assertEquals(out.totalEligible, 2);
  assertEquals(out.items.map((i) => i.item), [
    "trellis#2",
    "gh-project-room#1",
  ]);
  assert(out.items.every((i) => i.fitsRemaining)); // no budget -> all fit
});

Deno.test("ready verb: --budget threads capacity into fitsRemaining", async () => {
  const board = Array.from({ length: 3 }, (_, i) =>
    boardItem({
      number: i + 1,
      fields: { status: "Todo", effort: 6, value: 60 },
    }));
  const out = await readyVerb.run({ top: 10, budget: "rolling-5h" }, {
    reads: fakeReads(board),
  });
  // rolling-5h capacity 10: first fits (10->4), rest don't.
  assertEquals(out.items.map((i) => i.fitsRemaining), [true, false, false]);
  assertEquals(out.unknownBudget, false);
});
