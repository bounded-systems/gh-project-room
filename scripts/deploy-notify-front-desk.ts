/**
 * Deploy notify-front-desk.yml to every public org repo that doesn't have it.
 *
 * For repos that allow direct push: commits straight to main.
 * For repos with branch-protection rules: opens a PR from a new branch.
 *
 * Usage:
 *   deno run --allow-net=api.github.com --allow-env scripts/deploy-notify-front-desk.ts
 *
 * Required env: GITHUB_TOKEN with org repos write + contents write + pull-requests write.
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
const BRANCH = "feat/notify-front-desk";

const token = Deno.env.get("GITHUB_TOKEN");
if (!token) {
  console.error("GITHUB_TOKEN not set");
  Deno.exit(1);
}

async function gh(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
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

async function fileExists(repo: string): Promise<string | null> {
  const res = await gh(`/repos/${ORG}/${repo}/contents/${FILE_PATH}`);
  if (res.status === 200) {
    const data = await res.json() as { sha: string };
    return data.sha;
  }
  await res.body?.cancel();
  return null;
}

async function getDefaultBranchSha(repo: string, branch: string): Promise<string> {
  const res = await gh(`/repos/${ORG}/${repo}/git/ref/heads/${branch}`);
  const data = await res.json() as { object: { sha: string } };
  return data.object.sha;
}

async function createBranch(repo: string, base: string): Promise<void> {
  const sha = await getDefaultBranchSha(repo, base);
  await gh(`/repos/${ORG}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha }),
  });
}

async function putFile(repo: string, branch: string, existingSha?: string | null): Promise<number> {
  const content = btoa(NOTIFY_WORKFLOW);
  const body: Record<string, string> = { message: COMMIT_MSG, content, branch };
  if (existingSha) body.sha = existingSha;
  const res = await gh(`/repos/${ORG}/${repo}/contents/${FILE_PATH}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await res.body?.cancel();
  return res.status;
}

async function createPR(repo: string, defaultBranch: string): Promise<string> {
  const res = await gh(`/repos/${ORG}/${repo}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: COMMIT_MSG,
      head: BRANCH,
      base: defaultBranch,
      body: "Wires this repo into the Front Desk prioritization board — sweeps trigger on every issue/PR event.",
    }),
  });
  const data = await res.json() as { html_url: string };
  return data.html_url;
}

async function getDefaultBranch(repo: string): Promise<string> {
  const res = await gh(`/repos/${ORG}/${repo}`);
  const data = await res.json() as { default_branch: string };
  return data.default_branch;
}

const repos = await orgPublicRepos();
console.log(`Found ${repos.length} public repos to check.\n`);

for (const repo of repos) {
  const existing = await fileExists(repo);
  if (existing !== null) {
    console.log(`  skip  ${repo} (already deployed)`);
    continue;
  }

  const defaultBranch = await getDefaultBranch(repo);
  const status = await putFile(repo, defaultBranch);

  if (status === 201 || status === 200) {
    console.log(`  ✓ direct  ${repo}`);
    continue;
  }

  if (status === 403 || status === 409 || status === 422) {
    // Branch protection or forbidden direct push — try a PR instead.
    try {
      await createBranch(repo, defaultBranch);
      await putFile(repo, BRANCH);
      const url = await createPR(repo, defaultBranch);
      console.log(`  ✓ PR      ${repo}  ${url}`);
    } catch (err) {
      console.log(`  ✗ failed  ${repo}  ${err} (check App is installed on this repo)`);
    }
    continue;
  }

  console.log(`  ✗ failed  ${repo}  (HTTP ${status})`);
}
