/**
 * Deploy notify-front-desk.yml to every public org repo that doesn't have it.
 *
 * One deterministic path: read the file, then PUT it straight to the default
 * branch (idempotent — create if absent, update if drifted, skip if identical).
 * There is no PR fallback. The App is a bypass actor on the repos' branch
 * rulesets, so a direct write is always the intended mechanism; a 403 here
 * means a *config* problem (missing grant / not installed), not a branch that
 * needs working around. We fail loud on the first such 403 rather than
 * disguising it as a different code path.
 *
 * Required token grants (GitHub App installation token):
 *   - contents:  read + write
 *   - workflows: read + write   ← separate from contents; required for any
 *                                 file under .github/workflows/
 *
 * Usage:
 *   deno run --allow-net=api.github.com --allow-env scripts/deploy-notify-front-desk.ts
 */

const ORG = "bounded-systems";
const SKIP_REPOS = new Set(["gh-project-room"]); // already has native triggers

const NOTIFY_WORKFLOW = `name: notify-front-desk
on:
  issues:
    types: [opened, closed, reopened, labeled, unlabeled]
  pull_request:
    types: [opened, closed, reopened, labeled, unlabeled]
jobs:
  sync:
    uses: bounded-systems/gh-project-room/.github/workflows/trigger-sync.yml@main
    secrets: inherit
`;

const FILE_PATH = ".github/workflows/notify-front-desk.yml";
const COMMIT_MSG = "feat: notify Front Desk on issue/PR events";

const token = Deno.env.get("GITHUB_TOKEN");
if (!token) {
  console.error("GITHUB_TOKEN not set");
  Deno.exit(1);
}

/** A configuration error that will fail for *every* repo — stop immediately. */
class FatalConfigError extends Error {}

async function gh(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
}

async function orgPublicRepos(): Promise<string[]> {
  const repos: string[] = [];
  let page = 1;
  while (true) {
    const res = await gh(`/orgs/${ORG}/repos?type=public&per_page=100&page=${page}`);
    const data = await res.json() as Array<{ name: string; archived: boolean; private: boolean }>;
    if (!Array.isArray(data) || data.length === 0) break;
    for (const r of data) {
      if (!r.archived && !r.private && !SKIP_REPOS.has(r.name)) repos.push(r.name);
    }
    if (data.length < 100) break;
    page++;
  }
  return repos;
}

async function getDefaultBranch(repo: string): Promise<string> {
  const res = await gh(`/repos/${ORG}/${repo}`);
  const data = await res.json() as { default_branch: string };
  return data.default_branch;
}

/** Decode GitHub's base64-with-newlines blob (content is pure-ASCII YAML). */
function decodeContents(b64: string): string {
  return atob(b64.replace(/\n/g, ""));
}

/** Returns the existing file's sha + decoded content, or null if absent. */
async function getFile(
  repo: string,
): Promise<{ sha: string; content: string } | null> {
  const res = await gh(`/repos/${ORG}/${repo}/contents/${FILE_PATH}`);
  if (res.status === 200) {
    const data = await res.json() as { sha: string; content: string };
    return { sha: data.sha, content: decodeContents(data.content) };
  }
  await res.body?.cancel();
  return null;
}

/** PUT the file to the default branch. Throws FatalConfigError on a 403 that
 * indicates a missing grant — that condition is global, so we stop the run. */
async function putFile(
  repo: string,
  branch: string,
  existingSha?: string,
): Promise<void> {
  const body: Record<string, string> = {
    message: COMMIT_MSG,
    content: btoa(NOTIFY_WORKFLOW),
    branch,
  };
  if (existingSha) body.sha = existingSha;

  const res = await gh(`/repos/${ORG}/${repo}/contents/${FILE_PATH}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 200 || res.status === 201) {
    await res.body?.cancel();
    return;
  }

  const data = await res.json().catch(() => ({})) as { message?: string };
  const msg = data.message ?? "(no message)";

  // "Resource not accessible by integration" on a .github/workflows/ path means
  // the token lacks workflows:write (or contents:write, or isn't installed).
  // That's true for every repo — abort with the fix spelled out.
  if (res.status === 403 && /not accessible by integration/i.test(msg)) {
    throw new FatalConfigError(
      `HTTP 403: ${msg}\n` +
        `  → The App token is missing a grant for ${FILE_PATH}.\n` +
        `  → Ensure the App has BOTH 'contents: write' AND 'workflows: write',\n` +
        `    that the new permissions were accepted at the org installation page,\n` +
        `    and that the App is installed on ${ORG}/${repo}.`,
    );
  }

  throw new Error(`putFile HTTP ${res.status}: ${msg}`);
}

/** Re-read the file and assert it matches what we intended to write. */
async function verify(repo: string): Promise<boolean> {
  const file = await getFile(repo);
  return file?.content === NOTIFY_WORKFLOW;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const repos = await orgPublicRepos();
console.log(`Found ${repos.length} public repos to check.\n`);

const wrote: string[] = [];
const skipped: string[] = [];
const failed: Array<{ repo: string; reason: string }> = [];

try {
  for (const repo of repos) {
    const existing = await getFile(repo);

    if (existing && existing.content === NOTIFY_WORKFLOW) {
      console.log(`  skip    ${repo} (up to date)`);
      skipped.push(repo);
      continue;
    }

    const branch = await getDefaultBranch(repo);
    try {
      await putFile(repo, branch, existing?.sha);
      console.log(`  ${existing ? "update " : "create "} ${repo}`);
      wrote.push(repo);
    } catch (err) {
      if (err instanceof FatalConfigError) throw err;
      console.log(
        `  ✗ fail  ${repo}  ${err instanceof Error ? err.message : err}`,
      );
      failed.push({ repo, reason: String(err) });
    }
  }
} catch (err) {
  if (err instanceof FatalConfigError) {
    console.error(`\nFATAL (config — affects all repos):\n${err.message}`);
    Deno.exit(1);
  }
  throw err;
}

// ── Verify what we wrote ──────────────────────────────────────────────────────

if (wrote.length > 0) {
  console.log(`\nVerifying ${wrote.length} written repo(s)…`);
  for (const repo of wrote) {
    if (await verify(repo)) {
      console.log(`  ✓ ok    ${repo}`);
    } else {
      console.log(`  ✗ drift ${repo}  (write did not land as expected)`);
      failed.push({ repo, reason: "post-write verification failed" });
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(
  `\nDone. ${wrote.length} written, ${skipped.length} up to date, ${failed.length} failed.`,
);
if (failed.length > 0) {
  for (const f of failed) console.log(`  ✗ ${f.repo}: ${f.reason}`);
  Deno.exit(1);
}
