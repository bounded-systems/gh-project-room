import { assertEquals } from "@std/assert";
import type { BoardReads } from "./reads.ts";
import {
  bareRepo,
  scoutReads,
  toBoardItem,
  toOrgMergedPRs,
  toOrgRepos,
  toOrgWorkItems,
} from "./scout-reads.ts";

// The scout adapter must satisfy the whole BoardReads port — same drift guard
// as directReads, so a new read can't be added without wiring both adapters.
Deno.test("scoutReads: implements the whole BoardReads port", () => {
  const expected: Array<keyof BoardReads> = [
    "getProject",
    "boardItems",
    "orgOpenWorkItems",
    "orgMergedPullRequests",
    "existingContentIds",
    "orgRepos",
  ];
  for (const method of expected) {
    assertEquals(typeof scoutReads[method], "function", `scoutReads.${method}`);
  }
  assertEquals(Object.keys(scoutReads).sort(), [...expected].sort());
});

Deno.test("bareRepo: strips the owner scoutd reports (nameWithOwner)", () => {
  assertEquals(bareRepo("bounded-systems/gh-project-room"), "gh-project-room");
  assertEquals(bareRepo("gh-project-room"), "gh-project-room"); // already bare
  assertEquals(bareRepo(""), "");
});

Deno.test("toBoardItem: maps scout item → BoardItem (same field names as boardItems)", () => {
  const item = toBoardItem({
    number: 42,
    title: "do the thing",
    url: "https://github.com/bounded-systems/gh-project-room/issues/42",
    repo: "bounded-systems/gh-project-room",
    contentType: "Issue",
    state: "OPEN",
    contentId: "I_content",
    itemId: "PVTI_item",
    createdAt: "2026-07-01T00:00:00Z",
    isPrivate: false,
    fields: {
      Status: "Todo",
      Kind: "task",
      Effort: 3,
      Value: 8,
      "Depends on": "#7",
      Score: 12.5,
    },
  });
  assertEquals(item, {
    itemId: "PVTI_item",
    contentId: "I_content",
    number: 42,
    repo: "gh-project-room", // owner stripped
    isPrivate: false,
    ghState: "OPEN",
    createdAt: "2026-07-01T00:00:00Z",
    fields: {
      status: "Todo",
      kind: "task",
      effort: 3,
      value: 8,
      dependsOn: "#7",
      score: 12.5,
    },
  });
});

Deno.test("toBoardItem: missing/wrong-typed field values become null", () => {
  const item = toBoardItem({
    number: 1,
    title: "bare",
    url: "u",
    repo: "org/r",
    contentType: "PullRequest",
    state: "MERGED",
    contentId: "c",
    itemId: "i",
    createdAt: "2026-01-01T00:00:00Z",
    isPrivate: true,
    fields: {}, // no field values set
  });
  assertEquals(item.fields, {
    status: null,
    kind: null,
    effort: null,
    value: null,
    dependsOn: null,
    score: null,
  });
  assertEquals(item.ghState, "MERGED");
  assertEquals(item.isPrivate, true);
});

Deno.test("toOrgRepos: fail-closed on visibility unless includePrivate", () => {
  const out = {
    repos: [
      { id: "1", name: "pub", isPrivate: false },
      { id: "2", name: "priv", isPrivate: true },
    ],
  };
  // Default: only the explicitly-public repo reaches the public board.
  assertEquals(toOrgRepos(out, false), [{
    id: "1",
    name: "pub",
    isPrivate: false,
  }]);
  // Opt-in: both.
  assertEquals(toOrgRepos(out, true).map((r) => r.name), ["pub", "priv"]);
});

Deno.test("toOrgWorkItems: maps items + skipped, stripping repo owners", () => {
  const out = toOrgWorkItems({
    items: [{
      id: "I1",
      kind: "Issue",
      repo: "bounded-systems/scout",
      number: 5,
      title: "t",
      labels: ["epic"],
      hasSubIssues: true,
    }],
    skipped: [{ repo: "bounded-systems/secret", reason: "not accessible" }],
  });
  assertEquals(out.items[0].repo, "scout");
  assertEquals(out.items[0].hasSubIssues, true);
  assertEquals(out.skipped, [{ repo: "secret", reason: "not accessible" }]);
});

Deno.test("toOrgMergedPRs: maps items + skipped, stripping repo owners", () => {
  const out = toOrgMergedPRs({
    items: [{
      repo: "bounded-systems/mint",
      number: 9,
      title: "release",
      authorLogin: null,
      labels: [],
      closingIssueCount: 2,
    }],
    skipped: [],
  });
  assertEquals(out.items[0], {
    repo: "mint",
    number: 9,
    title: "release",
    authorLogin: null,
    labels: [],
    closingIssueCount: 2,
  });
});
