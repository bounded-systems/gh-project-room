/**
 * gh-project-room entrypoint — the central sweep (the "backstop" half of the
 * hybrid). This is what `.github/workflows/front-desk-sync.yml` runs.
 *
 *   1. apply — reconcile Front Desk's fields to the contract (idempotent).
 *   2. sync  — add every open issue/PR across ALL org repos that isn't on the
 *              board yet. New repos are picked up automatically (enumerated live).
 *
 * Per-repo event workflows (front-desk-add.yml) give instant adds; this run
 * catches anything they missed and keeps the schema in shape.
 *
 * Run:  deno run --allow-net=api.github.com --allow-env sync.ts
 * Env:  GITHUB_TOKEN (App installation token = the Front Desk door)
 *       DRY_RUN=1     preview only — reconcile read-only, add nothing
 */

import { FRONT_DESK_FIELDS, FRONT_DESK_VIEWS, FRONT_DESK_WORKFLOWS } from "./contract.ts";
import {
  addItem,
  applyField,
  applyWorkflow,
  checkView,
  existingContentIds,
  getProject,
  linkRepoToProject,
  orgOpenWorkItems,
  orgRepos,
} from "./projects.ts";

async function main(): Promise<void> {
  const dryRun = Deno.env.get("DRY_RUN") === "1";
  const log = (m: string): void => console.log(`${dryRun ? "[dry-run] " : ""}${m}`);

  const project = await getProject();
  log(`Front Desk: "${project.title}" (${project.id})`);

  // 0. link all org repos to the project (idempotent — adds the Projects tab to each repo)
  // Requires repository admin access on the App; skipped gracefully if not granted.
  const repos = await orgRepos();
  log(`linking ${repos.length} repos to Front Desk…`);
  if (!dryRun) {
    const failed: string[] = [];
    for (const repo of repos) {
      try {
        await linkRepoToProject(project.id, repo.id);
      } catch {
        failed.push(repo.name);
      }
    }
    const linked = repos.map((r) => r.name).filter((n) => !failed.includes(n));
    if (linked.length) log(`linked: ${linked.join(", ")}`);
    if (failed.length) log(`link skipped (needs repo admin on App): ${failed.join(", ")}`);
  } else {
    log(`would link: ${repos.map((r) => r.name).join(", ")}`);
  }

  // 1. apply the contract
  for (const spec of FRONT_DESK_FIELDS) {
    if (dryRun) {
      const present = project.fields.some((f) => f.name === spec.name);
      log(`field "${spec.name}": ${present ? "present" : "would create"}`);
      continue;
    }
    const r = await applyField(project, spec);
    if (r.action === "needs-manual") {
      log(`field "${r.field}": MANUAL — add option(s) in the UI: ${r.missingOptions.join(", ")}`);
    } else {
      log(`field "${r.field}": ${r.action}`);
    }
  }

  // 2. reconcile built-in workflows (enable/disable via updateProjectV2Workflow)
  for (const spec of FRONT_DESK_WORKFLOWS) {
    if (dryRun) {
      const w = project.workflows.find((w) => w.name === spec.name);
      if (!w) { log(`workflow "${spec.name}": not-found`); continue; }
      const drift = w.enabled !== spec.enabled;
      log(`workflow "${spec.name}": ${drift ? `drift (live=${w.enabled}, want=${spec.enabled})` : "ok"}`);
      continue;
    }
    const r = await applyWorkflow(project, spec);
    log(`workflow "${r.workflow}": ${r.action}`);
  }

  // 3. report view status (GitHub Projects v2 API has no create/update view
  //    mutations — views must be added via the UI; this logs what's missing)
  for (const spec of FRONT_DESK_VIEWS) {
    const r = checkView(project, spec);
    if (r.action === "missing") {
      log(`view "${r.view}": MISSING — add via Front Desk UI (+ New view)`);
    } else {
      log(`view "${r.view}": exists`);
    }
  }

  // 4. sweep all repos and add anything missing
  const onBoard = await existingContentIds(project.id);
  const work = await orgOpenWorkItems();
  const missing = work.filter((w) => !onBoard.has(w.id));
  log(`open items: ${work.length}, already on board: ${work.length - missing.length}, to add: ${missing.length}`);

  let added = 0;
  for (const w of missing) {
    if (dryRun) {
      log(`would add ${w.kind} ${w.repo}#${w.number} — ${w.title}`);
      continue;
    }
    await addItem(project.id, w.id);
    added++;
    log(`added ${w.kind} ${w.repo}#${w.number}`);
  }
  log(`done — ${dryRun ? "0 (dry-run)" : added} added.`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    Deno.exit(1);
  });
}
