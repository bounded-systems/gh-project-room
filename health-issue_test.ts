import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideTrackingAction,
  type ExistingTrackingIssue,
  formatTrackingBody,
  TRACKING_MARKER,
} from "./health-issue.ts";
import type { HealthRow } from "./health.ts";
import type { Scorecard } from "./health.ts";

function row(overrides: Partial<HealthRow> = {}): HealthRow {
  return {
    metric: "Coverage (open public items not on board)",
    kind: "gate",
    value: 0,
    ok: true,
    detail: "0 open item(s) missing from Front Desk",
    offenders: [],
    ...overrides,
  };
}

function card(rows: readonly HealthRow[]): Scorecard {
  return {
    rows,
    allGatesPass: rows.filter((r) => r.kind === "gate").every((r) => r.ok),
  };
}

Deno.test("decideTrackingAction: all green, no existing issue -> noop", () => {
  const action = decideTrackingAction(card([row()]), null);
  assertEquals(action.kind, "noop");
});

Deno.test("decideTrackingAction: all green, an open tracking issue exists -> close", () => {
  const existing: ExistingTrackingIssue = { number: 100, state: "open" };
  const action = decideTrackingAction(card([row()]), existing);
  assertEquals(action, { kind: "close", issueNumber: 100 });
});

Deno.test("decideTrackingAction: all green, tracking issue already closed -> noop", () => {
  const existing: ExistingTrackingIssue = { number: 100, state: "closed" };
  const action = decideTrackingAction(card([row()]), existing);
  assertEquals(action.kind, "noop");
});

Deno.test("decideTrackingAction: red gate, no existing issue -> create", () => {
  const redRow = row({ ok: false, value: 3, detail: "3 items missing" });
  const action = decideTrackingAction(card([redRow]), null);
  assertEquals(action.kind, "create");
  if (action.kind === "create") {
    assertStringIncludes(action.body, TRACKING_MARKER);
    assertStringIncludes(action.body, "3 items missing");
  }
});

Deno.test("decideTrackingAction: red gate, open tracking issue exists -> update (not a new issue)", () => {
  const redRow = row({ ok: false });
  const existing: ExistingTrackingIssue = { number: 42, state: "open" };
  const action = decideTrackingAction(card([redRow]), existing);
  assertEquals(action.kind, "update");
  if (action.kind === "update") assertEquals(action.issueNumber, 42);
});

Deno.test("decideTrackingAction: red gate, tracking issue was closed -> reopen with fresh body", () => {
  const redRow = row({ ok: false });
  const existing: ExistingTrackingIssue = { number: 42, state: "closed" };
  const action = decideTrackingAction(card([redRow]), existing);
  assertEquals(action.kind, "reopen");
  if (action.kind === "reopen") assertEquals(action.issueNumber, 42);
});

Deno.test("formatTrackingBody: includes only failing gate rows, not passing or report rows", () => {
  const rows: HealthRow[] = [
    row({ metric: "Coverage", ok: true }),
    row({
      metric: "Contract",
      ok: false,
      detail: "1 leaked",
      offenders: ["infra#7"],
    }),
    row({
      metric: "Off-roadmap report",
      kind: "report",
      ok: true,
      detail: "5 unlinked",
    }),
  ];
  const body = formatTrackingBody(rows);
  assertStringIncludes(body, "Contract");
  assertStringIncludes(body, "infra#7");
  assertEquals(body.includes("Off-roadmap report"), false);
  assertEquals(body.includes("## Coverage"), false);
});

Deno.test("formatTrackingBody: always includes the stable marker", () => {
  const body = formatTrackingBody([row({ ok: false })]);
  assertStringIncludes(body, TRACKING_MARKER);
});
