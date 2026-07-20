# Reads through scout — the query/get seam

**Status:** design + the seam landed; the scout adapter is a follow-up.

## Principle

Every **query/get** gh-project-room makes against GitHub goes through **one
injectable read-port**, not a direct API call scattered across modules. The port
lets the read *source* be swapped per environment without touching any caller's
logic. Writes are out of scope here — they belong to a write door, not scout.

## The layering (org-wide)

The org already has the "real request + cache" layer the reads should sit behind.
From the org registry graph (`.github/profile/README.md`):

```
caller (gh-project-room)
   │  a "get" — board items, org issues/PRs, merged PRs
   ▼
scout door  ……………  the read seam  (door-scout / scoutd; contract = scout-wire,
   │                                  in-box client = door-kit)
   ▼
github-budget  ………  the REAL request, rate-limit-aware + bucketed + audited
   ▼
cas + anchored-chain   the CACHE: bytes addressed by SHA-256 digest (cas),
                       with lineage + invalidation (anchored-chain)
```

- **`scout` / `scoutd`** — "the external-read capability door." The seam every
  in-box query passes through. `scout-wire` already declares the verbs we'd use:
  `project` (a Projects v2 board, read-only GraphQL), `issue`, `pr`, `repo`.
- **`github-budget`** — "rate-limit-aware gh wrapper with bucket classification
  and audit trail." Does the actual GitHub request, governed.
- **`cas`** — "content-addressable storage: bytes addressed by their SHA-256
  digest." The cache; identical reads dedup on digest.
- **`anchored-chain`** — "derivation chain with … lineage tracking, and
  invalidation." Provenance + cache-invalidation over the CAS blobs.

**gh-project-room does NOT cache.** Caching, provenance, and rate-limit governance
live behind the scout door. Our adapters are thin: the direct one is a
pass-through to the Projects v2 client; the scout one just calls through door-kit.

## The seam in this repo — `reads.ts`

`BoardReads` is the port — the read-only queries this repo needs
(`getProject`, `boardItems`, `orgOpenWorkItems`, `orgMergedPullRequests`,
`existingContentIds`, `orgRepos`). Method signatures are borrowed (`typeof`) from
the concrete client so the port and adapter can't disagree on shape.

Consumers depend on the port (or a slice of it), defaulting to `directReads`:
- `sync.ts` — `main(reads = directReads)`; every read call site goes through it.
  Writes (`addItem`, `setNumberValue`, …) stay direct.
- `health.ts` — `main(reads = directReads)`; the three fetches go through it.
- the `ready` verb (`verbs.ts`) — `deps: { reads }` (the `getProject`/`boardItems`
  slice), injectable per call / per MCP server build.

### Two adapters, one seam

| Adapter | Backed by | Runs where | Caching |
| --- | --- | --- | --- |
| `directReads` (**default, shipped**) | this repo's Projects v2 GraphQL client (`projects.ts`) | anywhere a `GITHUB_TOKEN` exists — the CI sweep, a token CLI | none (direct) |
| `scoutReads` (**follow-up**) | `scout-wire`'s `project`/`issue`/`pr`/`repo` via `door-kit` → `scoutd` | inside the claude-box sandbox | cas + anchored-chain, behind the door |

## Why the default can't just be scout

`front-desk-sync.yml` runs in **GitHub Actions**, outside claude-box — it cannot
reach `scoutd` (a sandbox door daemon). So the CI sweep must keep the direct
adapter. The scout adapter is for in-box agent runs. Same seam, injected per
environment — which is exactly why `reads.ts` is a port, not a hardcoded client.

## Follow-up: the scout adapter

Implement `scoutReads: BoardReads` over `scout-wire`'s verbs, called through the
`door-kit` in-box client. Needs `door-kit` + `door-scout` (not in this repo's
scope yet). It becomes the injected `reads` for in-box CLI runs and the
`opts.deps` for an in-box MCP server; `directReads` stays the CI/Actions default.
`existingContentIds` / `orgRepos` have no direct scout-wire verb yet — either add
wire verbs or derive them from `project` — decide when the adapter is built.
