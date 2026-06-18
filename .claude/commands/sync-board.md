Dispatch a Front Desk board sweep by triggering the `front-desk-sync.yml`
workflow via `workflow_dispatch` on `bounded-systems/gh-project-room`.

Use the `mcp__github__actions_run_trigger` tool with these exact parameters:
- method: "run_workflow"
- owner: "bounded-systems"
- repo: "gh-project-room"
- workflow_id: "front-desk-sync.yml"
- ref: "main"

After dispatching, confirm the run was queued and share the Actions URL so the
user can follow progress:
https://github.com/bounded-systems/gh-project-room/actions/workflows/front-desk-sync.yml
