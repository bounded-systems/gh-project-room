# gh-project-room

The Front Desk projection + sync **room** for bounded-systems — keeps org
project #2 ("Front Desk") in shape and tied to every repo, and (spike)
computes a behavioral prioritization + budget contract over it.

- `contract.ts` — the board contract (fields, views, workflows, insights).
- `prioritization.ts` — codeable prioritization + budget contract (spike).
- `sync.ts` / `projects.ts` — the Deno sweep that reconciles the live board.

Source-available under **PolyForm Noncommercial 1.0.0**. Extracted from
`bounded-systems/.github-private` (see its `docs/handoffs/gh-project-room.md`).
