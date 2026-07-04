# gh-project-room

The Front Desk projection + sync **room** for bounded-systems — keeps org
project #2 ("Front Desk") in shape and tied to every repo, and (spike)
computes a behavioral prioritization + budget contract over it.

- `contract.ts` — the board contract (fields, views, workflows, insights).
- `prioritization.ts` — codeable prioritization + budget contract (spike).
- `sync.ts` / `projects.ts` — the Deno sweep that reconciles the live board.

Source-available under **PolyForm Noncommercial 1.0.0**. Extracted from
`bounded-systems/.github-private` (see its `docs/handoffs/gh-project-room.md`).

## Usage

### Sync the board (CI)

```ts
// deno run --allow-net=api.github.com --allow-env sync.ts
// Env: GITHUB_TOKEN (App installation token), DRY_RUN=1 (preview only)
import "@bounded-systems/gh-project-room/sync";
```

### Read the board contract

```ts
import {
  FRONT_DESK_FIELDS,
  FRONT_DESK_VIEWS,
  FRONT_DESK_WORKFLOWS,
} from "@bounded-systems/gh-project-room";

// All field definitions the board must have
console.log(FRONT_DESK_FIELDS.map((f) => f.name));
```

### Dispatch a contract verb

The contract's checking functions (`classifyKind`, `checkView`, `checkWorkflow`)
are also projected as [`@bounded-systems/verbspec`](https://github.com/bounded-systems/verbspec)
verbs in `verbs.ts` — one Zod input/output schema per action, dispatchable as a
CLI and (via the same `VerbSpec`) as an MCP tool, an OpenAPI operation, or
JSON-RPC, with no separate handler to keep in sync:

```sh
deno run verbs.ts classify-kind --kind Issue --labels room
# "room"
```

This is Phase 1 of adopting VerbSpec here — a small, additive verb surface
over the existing contract; `sync.ts` is unchanged and keeps calling the
underlying functions directly. Modeling the *org-wide* door capability graph
(`door-keeper.signCommit`, `door-scout.readContent`, …) the same way is a
separate, later initiative — see `docs/org-map.md`'s reserved `door-sdk`
SDK-family slot.

### Prioritize work items

```ts
import {
  prioritize,
  WEEKLY_BUDGET,
} from "@bounded-systems/gh-project-room/prioritization";

const items = [
  {
    number: 1, title: "Fix login bug", kind: "bug" as const,
    state: "open" as const, effort: 2, value: 80, openBlockers: 0, unblocks: 3,
  },
  {
    number: 2, title: "Add dark mode", kind: "feature" as const,
    state: "open" as const, effort: 5, value: 40, openBlockers: 0, unblocks: 0,
  },
];

const queue = prioritize(items, WEEKLY_BUDGET.capacityPoints);
console.log(queue[0].title); // highest-priority item first
```
