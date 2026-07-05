/**
 * @module
 * CI check for the charter's traceability invariant, hard side (#54):
 * a PR must not close more than one issue. `closingIssuesReferences.totalCount`
 * is GitHub's own computed signal (from "Closes #N" style references in the
 * PR body/commits) — no heuristics needed here, unlike the exemption-aware
 * 0-issue report (#55).
 *
 * The >=2 rule is absolute — no exemptions (docs/front-desk-charter.md).
 *
 * Usage:
 *   deno run --allow-net=api.github.com --allow-env traceability-check.ts \
 *     --repo <owner/name> --pr <number>
 *
 * Env: GITHUB_TOKEN (repo-scoped read access is enough — same-repo PR data,
 * not the org-wide Front Desk App token used by sync.ts/webhook.ts).
 *
 * Exits 0 when totalCount <= 1, 1 when totalCount >= 2, 2 on bad arguments.
 */

interface Args {
  owner: string;
  repo: string;
  pr: number;
}

function parseArgs(args: string[]): Args {
  let repoArg = "";
  let pr = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo" && i + 1 < args.length) repoArg = args[++i];
    else if (args[i] === "--pr" && i + 1 < args.length) {
      pr = parseInt(args[++i], 10);
    }
  }
  const [owner, repo] = repoArg.split("/");
  if (!owner || !repo || !pr) {
    console.error(
      "Usage: traceability-check.ts --repo <owner/name> --pr <number>",
    );
    Deno.exit(2);
  }
  return { owner, repo, pr };
}

async function closingIssueCount(
  token: string,
  owner: string,
  repo: string,
  pr: number,
): Promise<number> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "gh-project-room",
    },
    body: JSON.stringify({
      query: `query($owner:String!,$repo:String!,$pr:Int!){
        repository(owner:$owner, name:$repo){
          pullRequest(number:$pr){ closingIssuesReferences{ totalCount } }
        }
      }`,
      variables: { owner, repo, pr },
    }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as {
    data?: {
      repository: {
        pullRequest: { closingIssuesReferences: { totalCount: number } };
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new Error("GraphQL: no data");
  return body.data.repository.pullRequest.closingIssuesReferences.totalCount;
}

export interface Verdict {
  readonly blocked: boolean;
  readonly message: string;
}

/**
 * Pure gate: the >=2 rule is absolute — no exemptions. 0 and 1 both pass here;
 * the 0 case is only ever a non-blocking report elsewhere (#55).
 */
export function evaluateTraceability(count: number): Verdict {
  if (count > 1) {
    return {
      blocked: true,
      message:
        `PR closes ${count} issues (>= 2) — conflated intents. Split this PR ` +
        `so each closes exactly one issue (docs/front-desk-charter.md, invariant 2).`,
    };
  }
  return {
    blocked: false,
    message: count === 1
      ? "PR closes exactly 1 issue — ideal."
      : "PR closes 0 issues — off-roadmap (reported separately, not blocked here; see #55).",
  };
}

if (import.meta.main) {
  const { owner, repo, pr } = parseArgs(Deno.args);
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) {
    console.error("GITHUB_TOKEN is not set.");
    Deno.exit(2);
  }

  const count = await closingIssueCount(token, owner, repo, pr);
  const verdict = evaluateTraceability(count);

  if (verdict.blocked) {
    console.error(verdict.message);
    Deno.exit(1);
  }
  console.log(verdict.message);
  Deno.exit(0);
}
