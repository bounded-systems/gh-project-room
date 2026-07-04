import { assertEquals } from "@std/assert";
import {
  type HealthInput,
  healthReport,
  isExemptFromClosingIssue,
} from "./health.ts";
import type {
  BoardItem,
  BoardItemFields,
  MergedPRInfo,
  OrgWorkItems,
} from "./projects.ts";

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

function mergedPR(overrides: Partial<MergedPRInfo> = {}): MergedPRInfo {
  return {
    repo: "gh-project-room",
    number: 1,
    title: "fix: something",
    authorLogin: "someone",
    labels: [],
    closingIssueCount: 1,
    ...overrides,
  };
}

const emptyOpenWork: OrgWorkItems = { items: [], skipped: [] };

Deno.test("healthReport: all-clean input passes every gate", () => {
  const input: HealthInput = {
    board: [
      boardItem({ number: 1, fields: { score: 2 } }),
      boardItem({ number: 2, fields: { score: 8 } }),
    ],
    openWork: { items: [], skipped: [] },
    mergedPRs: [mergedPR({ closingIssueCount: 1 })],
  };
  const card = healthReport(input);
  assertEquals(card.allGatesPass, true);
  for (const row of card.rows.filter((r) => r.kind === "gate")) {
    assertEquals(row.ok, true, row.metric);
  }
});

Deno.test("healthReport: coverage flags an open item missing from the board", () => {
  const openWork: OrgWorkItems = {
    items: [{
      id: "content-missing",
      kind: "Issue",
      repo: "gh-project-room",
      number: 99,
      title: "untracked work",
      labels: [],
      hasSubIssues: false,
    }],
    skipped: [],
  };
  const card = healthReport({ board: [], openWork, mergedPRs: [] });
  const row = card.rows.find((r) => r.metric.startsWith("Coverage"))!;
  assertEquals(row.ok, false);
  assertEquals(row.value, 1);
  assertEquals(row.offenders, ["gh-project-room#99"]);
  assertEquals(card.allGatesPass, false);
});

Deno.test("healthReport: contract flags a private-repo item on the board", () => {
  const board = [boardItem({ isPrivate: true, repo: "infra", number: 7 })];
  const card = healthReport({ board, openWork: emptyOpenWork, mergedPRs: [] });
  const row = card.rows.find((r) => r.metric.startsWith("Contract"))!;
  assertEquals(row.ok, false);
  assertEquals(row.offenders, ["infra#7"]);
});

Deno.test("healthReport: traceability (hard) flags PRs closing >= 2 issues, never exempt", () => {
  const mergedPRs = [
    mergedPR({ number: 10, closingIssueCount: 2 }),
    mergedPR({
      number: 11,
      closingIssueCount: 2,
      authorLogin: "dependabot[bot]",
    }),
  ];
  const card = healthReport({
    board: [],
    openWork: emptyOpenWork,
    mergedPRs,
  });
  const row = card.rows.find((r) =>
    r.metric.startsWith("Traceability — conflated")
  )!;
  assertEquals(row.value, 2);
  assertEquals(row.ok, false);
  assertEquals(card.allGatesPass, false);
});

Deno.test("healthReport: traceability (soft) reports 0-closing-issue PRs but never fails the gate", () => {
  const mergedPRs = [mergedPR({ number: 12, closingIssueCount: 0 })];
  const card = healthReport({ board: [], openWork: emptyOpenWork, mergedPRs });
  const row = card.rows.find((r) =>
    r.metric.startsWith("Traceability — off-roadmap")
  )!;
  assertEquals(row.kind, "report");
  assertEquals(row.value, 1);
  assertEquals(row.ok, true); // reports never fail
  assertEquals(card.allGatesPass, true);
});

Deno.test("healthReport: traceability (soft) honors the exemption contract", () => {
  const mergedPRs = [
    mergedPR({
      number: 13,
      closingIssueCount: 0,
      authorLogin: "dependabot[bot]",
    }),
    mergedPR({
      number: 14,
      closingIssueCount: 0,
      title: "chore: release 0.3.0",
    }),
  ];
  const card = healthReport({ board: [], openWork: emptyOpenWork, mergedPRs });
  const row = card.rows.find((r) =>
    r.metric.startsWith("Traceability — off-roadmap")
  )!;
  assertEquals(row.value, 0);
});

Deno.test("healthReport: prioritization fails when Score has zero variance (#60)", () => {
  const board = [
    boardItem({ fields: { score: -0.05 } }),
    boardItem({ fields: { score: -0.05 } }),
  ];
  const card = healthReport({ board, openWork: emptyOpenWork, mergedPRs: [] });
  const row = card.rows.find((r) => r.metric.startsWith("Prioritization"))!;
  assertEquals(row.ok, false);
  assertEquals(row.value, 0);
});

Deno.test("healthReport: prioritization passes when Score varies", () => {
  const board = [
    boardItem({ fields: { score: 1 } }),
    boardItem({ fields: { score: 5 } }),
  ];
  const card = healthReport({ board, openWork: emptyOpenWork, mergedPRs: [] });
  const row = card.rows.find((r) => r.metric.startsWith("Prioritization"))!;
  assertEquals(row.ok, true);
});

Deno.test("healthReport: status freshness flags a closed GitHub item still marked Todo", () => {
  const board = [
    boardItem({ ghState: "CLOSED", fields: { status: "Todo" } }),
  ];
  const card = healthReport({ board, openWork: emptyOpenWork, mergedPRs: [] });
  const row = card.rows.find((r) => r.metric.startsWith("Status freshness"))!;
  assertEquals(row.ok, false);
  assertEquals(row.value, 1);
});

Deno.test("healthReport: status freshness passes when Done tracks CLOSED/MERGED", () => {
  const board = [
    boardItem({ ghState: "CLOSED", fields: { status: "Done" } }),
    boardItem({ ghState: "MERGED", fields: { status: "Done" } }),
    boardItem({ ghState: "OPEN", fields: { status: "In progress" } }),
  ];
  const card = healthReport({ board, openWork: emptyOpenWork, mergedPRs: [] });
  const row = card.rows.find((r) => r.metric.startsWith("Status freshness"))!;
  assertEquals(row.ok, true);
});

Deno.test("isExemptFromClosingIssue: recognizes bot authors, dependency label, release title/label", () => {
  assertEquals(
    isExemptFromClosingIssue(mergedPR({ authorLogin: "dependabot[bot]" })),
    true,
  );
  assertEquals(
    isExemptFromClosingIssue(mergedPR({ authorLogin: "renovate[bot]" })),
    true,
  );
  assertEquals(
    isExemptFromClosingIssue(mergedPR({ labels: ["dependencies"] })),
    true,
  );
  assertEquals(
    isExemptFromClosingIssue(mergedPR({ title: "chore: release 1.2.3" })),
    true,
  );
  assertEquals(
    isExemptFromClosingIssue(mergedPR({ labels: ["release"] })),
    true,
  );
  assertEquals(
    isExemptFromClosingIssue(mergedPR({
      title: "feat: add widget",
      labels: [],
      authorLogin: "a-human",
    })),
    false,
  );
});
