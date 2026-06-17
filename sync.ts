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

import {
  classifyKind,
  EFFORT_FIELD,
  FRONT_DESK_FIELDS,
  FRONT_DESK_VIEWS,
  FRONT_DESK_WORKFLOWS,
  SCORE_FIELD,
  TYPE_FIELD,
  VALUE_FIELD,
} from "./contract.ts";
import { score } from "./prioritization.ts";
import {
  addItem,
  applyField,
  checkView,
  checkWorkflow,
  existingContentIds,
  getProject,
  linkRepoToProject,
  orgOpenWorkItems,
  orgRepos,
  projectItems,
  setNumberValue,
  setSingleSelectValue,
} from "./projects.ts";

async function main(): Promise<void> {
  const dryRun = Deno.env.get("DRY_RUN") === "1";
  const log = (m: string): void =>
    console.log(`${dryRun ? "[dry-run] " : ""}${m}`);

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
    if (failed.length) {
      log(`link skipped (needs repo admin on App): ${failed.join(", ")}`);
    }
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
      log(
        `field "${r.field}": MANUAL — add option(s) in the UI: ${
          r.missingOptions.join(", ")
        }`,
      );
    } else {
      log(`field "${r.field}": ${r.action}`);
    }
  }

  // 2. report workflow status (GitHub Projects v2 API has no updateProjectV2Workflow
  //    mutation in the public API — same as views; toggle via the UI Workflows tab)
  for (const spec of FRONT_DESK_WORKFLOWS) {
    const r = checkWorkflow(project, spec);
    if (r.action === "drift") {
      log(
        `workflow "${r.workflow}": DRIFT (live=${r.live}, want=${r.want}) — toggle via Front Desk UI Workflows tab`,
      );
    } else {
      log(`workflow "${r.workflow}": ${r.action}`);
    }
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
  log(
    `open items: ${work.length}, already on board: ${
      work.length - missing.length
    }, to add: ${missing.length}`,
  );

  // Resolve the Kind field for auto-classification (#51). It may have just been
  // created in step 1, so the getProject() snapshot can predate it — re-fetch
  // once if it's missing. Setting Kind only on freshly added items keeps re-runs
  // idempotent and never clobbers a manually-chosen value.
  let kindField = project.fields.find((f) => f.name === TYPE_FIELD.name);
  if (!dryRun && !kindField) {
    kindField = (await getProject()).fields.find((f) =>
      f.name === TYPE_FIELD.name
    );
  }
  const kindOptionId = (name: string): string | undefined =>
    kindField?.options.find((o) => o.name === name)?.id;

  let added = 0;
  for (const w of missing) {
    const kind = classifyKind(w);
    if (dryRun) {
      log(
        `would add ${w.kind} ${w.repo}#${w.number} — ${w.title} [Kind→${kind}]`,
      );
      continue;
    }
    const itemId = await addItem(project.id, w.id);
    added++;
    const oid = kindOptionId(kind);
    if (kindField && oid) {
      await setSingleSelectValue(project.id, itemId, kindField.id, oid);
      log(`added ${w.kind} ${w.repo}#${w.number} [Kind→${kind}]`);
    } else {
      log(
        `added ${w.kind} ${w.repo}#${w.number} (Kind field unavailable — set manually)`,
      );
    }
  }
  log(`done — ${dryRun ? "0 (dry-run)" : added} added.`);

  // 5. Write back computed Score for every on-board item (#7).
  //    Only writes when the value changes (rounded to 2dp) to avoid activity churn.
  //    Score is computed from Effort + Value on the board; openBlockers/unblocks
  //    default to 0 until structured edge data is available (#10).
  let effortField = project.fields.find((f) => f.name === EFFORT_FIELD.name);
  let valueField = project.fields.find((f) => f.name === VALUE_FIELD.name);
  let scoreField = project.fields.find((f) => f.name === SCORE_FIELD.name);
  if (!dryRun && (!effortField || !valueField || !scoreField)) {
    const fresh = (await getProject()).fields;
    effortField ??= fresh.find((f) => f.name === EFFORT_FIELD.name);
    valueField ??= fresh.find((f) => f.name === VALUE_FIELD.name);
    scoreField ??= fresh.find((f) => f.name === SCORE_FIELD.name);
  }
  if (!effortField || !valueField || !scoreField) {
    log(
      `score: Effort/Value/Score fields not yet on board — skipping write-back`,
    );
  } else {
    const items = dryRun ? [] : await projectItems(project.id);
    let scoreWrites = 0;
    for (const item of items) {
      const effort = item.numbers.get(effortField.id) ?? 0;
      const value = item.numbers.get(valueField.id) ?? 0;
      const currentRaw = item.numbers.get(scoreField.id);
      const current = currentRaw != null
        ? Math.round(currentRaw * 100) / 100
        : null;
      const computed = Math.round(
        score({
          number: 0,
          title: "",
          kind: "task",
          state: item.contentState,
          effort,
          value,
          openBlockers: 0,
          unblocks: 0,
        }) * 100,
      ) / 100;
      if (current !== computed) {
        await setNumberValue(project.id, item.itemId, scoreField.id, computed);
        scoreWrites++;
      }
    }
    if (dryRun) {
      log(`score: dry-run — would compute Score for all on-board items`);
    } else {
      log(`score: ${scoreWrites} write(s)`);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    Deno.exit(1);
  });
}
