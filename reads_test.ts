import { assertEquals } from "@std/assert";
import { type BoardReads, directReads } from "./reads.ts";

// The direct adapter must expose every read on the port — a drift guard so a
// new BoardReads method can't be added without wiring the default adapter.
Deno.test("directReads: implements the whole BoardReads port", () => {
  const expected: Array<keyof BoardReads> = [
    "getProject",
    "boardItems",
    "orgOpenWorkItems",
    "orgMergedPullRequests",
    "existingContentIds",
    "orgRepos",
  ];
  for (const method of expected) {
    assertEquals(
      typeof directReads[method],
      "function",
      `directReads.${method} should be a function`,
    );
  }
  assertEquals(Object.keys(directReads).sort(), [...expected].sort());
});
