import { assertEquals } from "@std/assert";
import { classify } from "./webhook.ts";

Deno.test("classify: issue opened", () => {
  const c = classify("issues", {
    action: "opened",
    issue: { node_id: "I_1", labels: [{ name: "bug" }] },
  });
  assertEquals(c, {
    contentId: "I_1",
    kind: "Issue",
    labels: ["bug"],
    action: "opened",
  });
});

Deno.test("classify: issue reopened (#53)", () => {
  const c = classify("issues", {
    action: "reopened",
    issue: { node_id: "I_2", labels: [] },
  });
  assertEquals(c?.action, "reopened");
  assertEquals(c?.kind, "Issue");
});

Deno.test("classify: issue closed (#53)", () => {
  const c = classify("issues", {
    action: "closed",
    issue: { node_id: "I_3", labels: [] },
  });
  assertEquals(c?.action, "closed");
});

Deno.test("classify: pull_request opened/reopened/closed", () => {
  for (const action of ["opened", "reopened", "closed"] as const) {
    const c = classify("pull_request", {
      action,
      pull_request: { node_id: "PR_1" },
    });
    assertEquals(c, {
      contentId: "PR_1",
      kind: "PullRequest",
      labels: [],
      action,
    });
  }
});

Deno.test("classify: ignores actions other than opened/reopened/closed", () => {
  for (const action of ["labeled", "edited", "synchronize", "assigned"]) {
    assertEquals(
      classify("issues", { action, issue: { node_id: "I_4" } }),
      null,
    );
    assertEquals(
      classify("pull_request", { action, pull_request: { node_id: "PR_2" } }),
      null,
    );
  }
});

Deno.test("classify: ignores unrelated event types", () => {
  assertEquals(
    classify("push", { action: "opened" }),
    null,
  );
  assertEquals(classify(null, { action: "opened" }), null);
});

Deno.test("classify: missing node_id returns null", () => {
  assertEquals(classify("issues", { action: "opened", issue: {} }), null);
  assertEquals(
    classify("pull_request", { action: "opened", pull_request: {} }),
    null,
  );
});
