import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readyReport, readyView, renderReadyTable } from "./ready.ts";
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

Deno.test("readyReport: higher score ranks first", () => {
  const items = [
    // low value-density: density 1, score ~0.5
    boardItem({ number: 1, fields: { status: "Todo", effort: 10, value: 10 } }),
    // high value-density: density 40, score ~39.9
    boardItem({ number: 2, fields: { status: "Todo", effort: 2, value: 80 } }),
  ];
  const report = readyReport(items);
  assertEquals(report.rows.map((r) => r.label), [
    "gh-project-room#2",
    "gh-project-room#1",
  ]);
});

Deno.test("readyReport: excludes ineligible items (Done, Blocked, open blocker)", () => {
  const items = [
    boardItem({ number: 1, fields: { status: "Todo" } }),
    boardItem({ number: 2, fields: { status: "Done" } }),
    boardItem({ number: 3, fields: { status: "Blocked" } }),
    boardItem({ number: 4, fields: { status: "Todo", dependsOn: "#1" } }), // #1 not Done -> blocked
  ];
  const report = readyReport(items);
  const labels = report.rows.map((r) => r.label);
  assertEquals(labels, ["gh-project-room#1"]);
  assertEquals(report.totalEligible, 1);
});

Deno.test("readyReport: a dependency marked Done no longer blocks", () => {
  const items = [
    boardItem({ number: 1, fields: { status: "Done" } }),
    boardItem({ number: 2, fields: { status: "Todo", dependsOn: "#1" } }),
  ];
  const report = readyReport(items);
  // #1 is closed (excluded); #2 depends only on the Done #1 -> eligible.
  assertEquals(report.rows.map((r) => r.label), ["gh-project-room#2"]);
});

Deno.test("readyReport: --top truncates rows but totalEligible is the full count", () => {
  const items = Array.from(
    { length: 5 },
    (_, i) => boardItem({ number: i + 1, fields: { status: "Todo" } }),
  );
  const report = readyReport(items, { top: 2 });
  assertEquals(report.rows.length, 2);
  assertEquals(report.totalEligible, 5);
});

Deno.test("readyReport: --budget flips fitsRemaining once capacity is spent", () => {
  // Three eligible items, effort 6 each (value 60 -> density 10, same score).
  // rolling-5h capacity is 10: the first fits (budgetLeft 10->4), the rest don't.
  const items = Array.from({ length: 3 }, (_, i) =>
    boardItem({
      number: i + 1,
      fields: { status: "Todo", effort: 6, value: 60 },
    }));

  const scoped = readyReport(items, { budgetId: "rolling-5h" });
  assertEquals(scoped.unknownBudget, false);
  assertEquals(scoped.rows.length, 3);
  assertEquals(scoped.rows[0].ranked.fitsRemaining, true);
  assertEquals(scoped.rows[1].ranked.fitsRemaining, false);
  assertEquals(scoped.rows[2].ranked.fitsRemaining, false);

  // Without a budget, remaining capacity is Infinity -> everything fits.
  const open = readyReport(items);
  assert(open.rows.every((r) => r.ranked.fitsRemaining));
});

Deno.test("readyReport: unknown budget id fails open (all items fit)", () => {
  const items = [
    boardItem({ number: 1, fields: { status: "Todo", effort: 50, value: 50 } }),
  ];
  const report = readyReport(items, { budgetId: "nope" });
  assertEquals(report.unknownBudget, true);
  assertEquals(report.rows[0].ranked.fitsRemaining, true);
});

Deno.test("readyReport: density and label are surfaced per row", () => {
  const items = [
    boardItem({
      number: 42,
      repo: "trellis",
      fields: { status: "Todo", effort: 4, value: 80 },
    }),
  ];
  const report = readyReport(items);
  assertEquals(report.rows[0].label, "trellis#42");
  assertEquals(report.rows[0].density, 20); // value 80 / effort 4
});

Deno.test("readyView: flattens a report into ranked, tool-facing items", () => {
  const items = [
    boardItem({ number: 1, fields: { status: "Todo", effort: 10, value: 10 } }),
    boardItem({
      number: 2,
      repo: "trellis",
      fields: { status: "Todo", effort: 2, value: 80 },
    }),
  ];
  const view = readyView(readyReport(items));
  assertEquals(view.totalEligible, 2);
  assertEquals(view.unknownBudget, false);
  // Highest score first, ranks are 1-based and dense.
  assertEquals(view.items.map((i) => [i.rank, i.item]), [
    [1, "trellis#2"],
    [2, "gh-project-room#1"],
  ]);
  assertEquals(view.items[0].density, 40); // 80 / 2
  assertEquals(view.items[0].kind, "task");
  // No budget -> everything fits.
  assert(view.items.every((i) => i.fitsRemaining));
});

Deno.test("renderReadyTable: shows a header, rows, and a FITS column under budget", () => {
  const items = Array.from({ length: 2 }, (_, i) =>
    boardItem({
      number: i + 1,
      fields: { status: "Todo", effort: 6, value: 60 },
    }));
  const table = renderReadyTable(readyView(
    readyReport(items, { budgetId: "rolling-5h" }),
  ));
  assertStringIncludes(table, "SCORE");
  assertStringIncludes(table, "FITS");
  assertStringIncludes(table, "gh-project-room#1");
  assertStringIncludes(table, 'against budget "rolling-5h"');
});

Deno.test("renderReadyTable: empty queue prints a clear message", () => {
  const table = renderReadyTable(readyView(readyReport([])));
  assertStringIncludes(table, "No ready items");
});
