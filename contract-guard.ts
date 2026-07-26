/**
 * @module
 * Contract-first guard (#83). The sweep reconciles the live board toward the
 * `contract.ts` it was CHECKED OUT with. If that contract is stale — main has a
 * newer `contract.ts` merged since this run's checkout — reconciling would
 * re-create fields the newer contract removed (the drift ping-pong of
 * 2026-07-25, when a stale sweep re-added the deleted date fields).
 *
 * This is a compare-and-swap at the reconcile boundary: compare the `contract.ts`
 * blob at the RUNNING commit against the one at `main`. If they differ, the
 * running schema is stale → the caller SKIPS field reconciliation (never aborts
 * the whole sweep; add-items + score writes are idempotent and still run). The
 * up-to-date sweep that runs on the newer commit applies the correct schema.
 *
 * FAIL-OPEN by construction: a local run (no GITHUB_SHA), a missing token, or any
 * API error returns `stale: false` — the guard never blocks a sweep it can't
 * prove is stale, so it can only PREVENT the known bug, never cause a new one.
 */

export interface DriftResult {
  readonly stale: boolean;
  readonly running?: string;
  readonly mainSha?: string;
  readonly reason?: string;
}

async function blobSha(
  fetchImpl: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const res = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${
      encodeURIComponent(ref)
    }`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "gh-project-room",
      },
    },
  );
  if (!res.ok) return null;
  const j = await res.json() as { sha?: unknown };
  return typeof j.sha === "string" ? j.sha : null;
}

export async function contractStale(opts: {
  readonly token?: string;
  readonly runningSha?: string;
  readonly owner?: string;
  readonly repo?: string;
  readonly path?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<DriftResult> {
  const {
    token,
    runningSha,
    owner = "bounded-systems",
    repo = "gh-project-room",
    path = "contract.ts",
    fetchImpl = fetch,
  } = opts;

  if (!runningSha) {
    return {
      stale: false,
      reason: "no running SHA (local run) — cannot check",
    };
  }
  if (!token) return { stale: false, reason: "no token — cannot check" };

  const [atRunning, atMain] = await Promise.all([
    blobSha(fetchImpl, token, owner, repo, path, runningSha),
    blobSha(fetchImpl, token, owner, repo, path, "main"),
  ]);
  if (!atRunning || !atMain) {
    return { stale: false, reason: "could not resolve blobs — fail-open" };
  }

  return { stale: atRunning !== atMain, running: atRunning, mainSha: atMain };
}
