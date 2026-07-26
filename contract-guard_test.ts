import { assertEquals } from "jsr:@std/assert@^1";
import { contractStale } from "./contract-guard.ts";

/** Mock the GitHub contents API: return a blob sha per ref. */
function mockFetch(shaByRef: Record<string, string | null>): typeof fetch {
  return ((url: string | URL | Request): Promise<Response> => {
    const ref = new URL(url as string).searchParams.get("ref") ?? "";
    const sha = shaByRef[ref];
    if (sha == null) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ sha }), { status: 200 }),
    );
  }) as typeof fetch;
}

Deno.test("stale when contract.ts blob differs between running commit and main", async () => {
  const r = await contractStale({
    token: "t",
    runningSha: "aaa",
    fetchImpl: mockFetch({ aaa: "blob-old", main: "blob-new" }),
  });
  assertEquals(r.stale, true);
  assertEquals(r.running, "blob-old");
  assertEquals(r.mainSha, "blob-new");
});

Deno.test("NOT stale when the blob is identical (main advanced but contract unchanged)", async () => {
  const r = await contractStale({
    token: "t",
    runningSha: "aaa",
    fetchImpl: mockFetch({ aaa: "same-blob", main: "same-blob" }),
  });
  assertEquals(r.stale, false);
});

Deno.test("fail-open: no running SHA (local run) → not stale", async () => {
  const r = await contractStale({ token: "t", fetchImpl: mockFetch({}) });
  assertEquals(r.stale, false);
});

Deno.test("fail-open: no token → not stale", async () => {
  const r = await contractStale({
    runningSha: "aaa",
    fetchImpl: mockFetch({ aaa: "x", main: "y" }),
  });
  assertEquals(r.stale, false);
});

Deno.test("fail-open: API error resolving a blob → not stale (never blocks on uncertainty)", async () => {
  const r = await contractStale({
    token: "t",
    runningSha: "aaa",
    fetchImpl: mockFetch({ aaa: "x" }), // main missing → 404
  });
  assertEquals(r.stale, false);
});
