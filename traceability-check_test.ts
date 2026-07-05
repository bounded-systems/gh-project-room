import { assertEquals } from "@std/assert";
import { evaluateTraceability } from "./traceability-check.ts";

Deno.test("evaluateTraceability: 0 closing issues passes (off-roadmap report, not a gate)", () => {
  const v = evaluateTraceability(0);
  assertEquals(v.blocked, false);
});

Deno.test("evaluateTraceability: 1 closing issue passes (ideal)", () => {
  const v = evaluateTraceability(1);
  assertEquals(v.blocked, false);
});

Deno.test("evaluateTraceability: 2 closing issues blocks", () => {
  const v = evaluateTraceability(2);
  assertEquals(v.blocked, true);
});

Deno.test("evaluateTraceability: >2 closing issues blocks, no exemption", () => {
  const v = evaluateTraceability(5);
  assertEquals(v.blocked, true);
});
