import { assertEquals } from "@std/assert";
import {
  DEFAULT_WEIGHTS,
  FALLBACK_AGE_CAP_DAYS,
  FALLBACK_AGE_WEIGHT_PER_DAY,
  FALLBACK_KIND_WEIGHT,
  isEligible,
  type PriorityInput,
  score,
} from "./prioritization.ts";

function item(overrides: Partial<PriorityInput> = {}): PriorityInput {
  return {
    number: 1,
    title: "#1",
    kind: "task",
    state: "open",
    effort: 0,
    value: 0,
    openBlockers: 0,
    unblocks: 0,
    ...overrides,
  };
}

Deno.test("score: ineligible items always score 0", () => {
  assertEquals(score(item({ state: "blocked" })), 0);
  assertEquals(score(item({ openBlockers: 1 })), 0);
  assertEquals(score(item({ state: "closed" })), 0);
});

Deno.test("score: estimated path is unchanged when Effort or Value is set", () => {
  // value=50, effort=5 -> density=10, no unblocks -> 1*10 - 0.05*5 = 9.75
  assertEquals(score(item({ effort: 5, value: 50 })), 9.75);
  // effort=0 (clamped to 1) but value set -> not the no-estimate case
  assertEquals(score(item({ effort: 0, value: 10 })), 10 - 0.05);
});

Deno.test("score: #60 fallback — no longer collapses to a constant across Kinds", () => {
  const epic = score(item({ kind: "epic" }));
  const room = score(item({ kind: "room" }));
  const door = score(item({ kind: "door" }));
  const task = score(item({ kind: "task" }));
  assertEquals(epic, FALLBACK_KIND_WEIGHT.epic);
  assertEquals(room, FALLBACK_KIND_WEIGHT.room);
  assertEquals(door, FALLBACK_KIND_WEIGHT.door);
  assertEquals(task, FALLBACK_KIND_WEIGHT.task);
  // epics rank above ordinary tasks with the same (absent) estimate
  const scores = new Set([epic, room, door, task]);
  if (scores.size < 2) {
    throw new Error("fallback still collapses to a constant");
  }
});

Deno.test("score: #60 fallback — unblocks still carries its normal weight", () => {
  const withoutUnblocks = score(item({ unblocks: 0 }));
  const withUnblocks = score(item({ unblocks: 3 }));
  assertEquals(withUnblocks - withoutUnblocks, DEFAULT_WEIGHTS.flow * 3);
});

Deno.test("score: #60 fallback — age nudges score up, capped", () => {
  const fresh = score(item({ ageDays: 0 }));
  const old = score(item({ ageDays: 30 }));
  const ancient = score(item({ ageDays: 10_000 }));
  const cappedAtLimit = score(item({ ageDays: FALLBACK_AGE_CAP_DAYS }));
  assertEquals(
    Math.round((old - fresh) * 1e6) / 1e6,
    FALLBACK_AGE_WEIGHT_PER_DAY * 30,
  );
  assertEquals(ancient, cappedAtLimit); // age contribution caps out
});

Deno.test("score: #60 fallback never fires once value or effort is nonzero, even at 0 age", () => {
  // A same-day item with a real (if small) estimate should be governed by the
  // density formula, not silently re-enter the no-estimate fallback.
  const estimated = score(item({ effort: 1, value: 1, ageDays: 0 }));
  assertEquals(
    estimated,
    DEFAULT_WEIGHTS.density * 1 - DEFAULT_WEIGHTS.effortPenalty * 1,
  );
});

Deno.test("isEligible: open/in_progress with no open blockers only", () => {
  assertEquals(isEligible(item({ state: "open" })), true);
  assertEquals(isEligible(item({ state: "in_progress" })), true);
  assertEquals(isEligible(item({ state: "blocked" })), false);
  assertEquals(isEligible(item({ state: "closed" })), false);
  assertEquals(isEligible(item({ openBlockers: 1 })), false);
});
