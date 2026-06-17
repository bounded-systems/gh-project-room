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

import { FRONT_DESK_FIELDS, FRONT_DESK_VIEWS } from "./contract.ts";
import {
  addItem,
  applyField,
  applyView,
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
  const repos = await orgRepos();
  log(`linking ${repos.length} repos to Front Desk…`);
  if (!dryRun) {
    for (const repo of repos) {
      await linkRepoToProject(project.id, repo.id);
    }
    log(`linked: ${repos.map((r) => r.name).join(", ")}`);
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

  // 2. reconcile views
  for (const spec of FRONT_DESK_VIEWS) {
    if (dryRun) {
      const present = project.views.some((v) => v.name === spec.name);
      log(`view "${spec.name}": ${present ? "present" : "would create"}`);
      continue;
    }
    const r = await applyView(project, spec);
    log(`view "${r.view}": ${r.action}`);
  }

  // 3. sweep all repos and add anything missing
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
