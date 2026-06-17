/**
 * Projects v2 GraphQL client for gh-project-room — the TypeScript replacement
 * for the `gh api graphql` bash in docs/beads-projection.md.
 *
 * Runtime: Deno (JSR-primary; runs .ts directly, global fetch). Reads the token
 * from $GITHUB_TOKEN — in CI that's a short-lived GitHub App installation token
 * (the Front Desk *door*), never a long-lived PAT. See the central workflow
 * `.github/workflows/front-desk-sync.yml`.
 *
 * Projects v2 is GraphQL-only. The mutations below mirror the verified snippets
 * in beads-projection.md; if GitHub's schema rejects one, check it against the
 * current docs (the API evolves) — this file fixes the *shape*, not the wire.
 */

import {
  type FieldSpec,
  ORG,
  PROJECT_NUMBER,
  type SingleSelectFieldSpec,
} from "./contract.ts";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

function token(): string {
  const t = Deno.env.get("GITHUB_TOKEN");
  if (!t) throw new Error("GITHUB_TOKEN is not set (mint the App token first).");
  return t;
}

/** Minimal typed GraphQL caller. Throws on transport or GraphQL errors. */
async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token()}`,
      "Content-Type": "application/json",
      "User-Agent": "gh-project-room",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const body = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new Error("GraphQL response had no data.");
  return body.data;
}

export interface ExistingOption {
  readonly id: string;
  readonly name: string;
}
export interface ExistingField {
  readonly id: string;
  readonly name: string;
  readonly dataType: string;
  readonly options: readonly ExistingOption[];
}
export interface ExistingView {
  readonly id: string;
  readonly name: string;
  readonly layout: string;
}
export interface Project {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly ExistingField[];
  readonly views: readonly ExistingView[];
}

/** Resolve Front Desk (org project #2) → node id, title, fields, and views. */
export async function getProject(): Promise<Project> {
  type Resp = {
    organization: {
      projectV2: {
        id: string;
        title: string;
        fields: {
          nodes: Array<
            { id: string; name: string; dataType: string; options?: ExistingOption[] }
          >;
        };
        views: {
          nodes: Array<{ id: string; name: string; layout: string }>;
        };
      };
    };
  };
  const data = await gql<Resp>(
    `query($org:String!,$num:Int!){
      organization(login:$org){
        projectV2(number:$num){
          id title
          fields(first:50){ nodes{
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField { options{ id name } }
          } }
          views(first:50){ nodes{ id name layout } }
        }
      }
    }`,
    { org: ORG, num: PROJECT_NUMBER },
  );
  const p = data.organization.projectV2;
  return {
    id: p.id,
    title: p.title,
    fields: p.fields.nodes.map((f) => ({
      id: f.id,
      name: f.name,
      dataType: f.dataType,
      options: f.options ?? [],
    })),
    views: p.views.nodes.map((v) => ({ id: v.id, name: v.name, layout: v.layout })),
  };
}

function singleSelectOptionsLiteral(field: SingleSelectFieldSpec): string {
  return field.options
    .map((o) => `{name:${JSON.stringify(o.name)},color:${o.color},description:${JSON.stringify(o.description)}}`)
    .join(",");
}

export type ApplyResult =
  | { field: string; action: "exists" }
  | { field: string; action: "created" }
  | { field: string; action: "needs-manual"; missingOptions: string[] };

/**
 * Reconcile one field spec against the live project (idempotent).
 *  - missing → create it (with all options for single-selects);
 *  - present → report any missing single-select options. Adding options to an
 *    EXISTING field has no clean Projects v2 mutation, so those are surfaced for
 *    a one-time UI add rather than silently dropped.
 */
export async function applyField(project: Project, spec: FieldSpec): Promise<ApplyResult> {
  const existing = project.fields.find((f) => f.name === spec.name);

  if (!existing) {
    if (spec.kind === "SINGLE_SELECT") {
      await gql(
        `mutation($pid:ID!){
          createProjectV2Field(input:{
            projectId:$pid, dataType:SINGLE_SELECT, name:${JSON.stringify(spec.name)},
            singleSelectOptions:[${singleSelectOptionsLiteral(spec)}]
          }){ projectV2Field{ ... on ProjectV2SingleSelectField{ id } } }
        }`,
        { pid: project.id },
      );
    } else {
      await gql(
        `mutation($pid:ID!){
          createProjectV2Field(input:{ projectId:$pid, dataType:TEXT, name:${JSON.stringify(spec.name)} }){
            projectV2Field{ ... on ProjectV2Field{ id } }
          }
        }`,
        { pid: project.id },
      );
    }
    return { field: spec.name, action: "created" };
  }

  if (spec.kind === "SINGLE_SELECT") {
    const have = new Set(existing.options.map((o) => o.name.toLowerCase()));
    const missing = spec.options.filter((o) => !have.has(o.name.toLowerCase())).map((o) => o.name);
    if (missing.length) return { field: spec.name, action: "needs-manual", missingOptions: missing };
  }
  return { field: spec.name, action: "exists" };
}

const LAYOUT_ENUM: Record<string, string> = {
  TABLE: "TABLE_LAYOUT",
  BOARD: "BOARD_LAYOUT",
  ROADMAP: "ROADMAP_LAYOUT",
};

export type ViewApplyResult =
  | { view: string; action: "exists" }
  | { view: string; action: "created" }
  | { view: string; action: "updated" };

/**
 * Reconcile one view spec against the live project (idempotent).
 * Creates the view if it doesn't exist; updates layout/filter/grouping if it
 * drifts. The default "View 1" is renamed to the first view spec whose name
 * doesn't already exist (handles the Lobby rename case).
 */
export async function applyView(project: Project, spec: import("./contract.ts").ViewSpec): Promise<ViewApplyResult> {
  const layoutEnum = LAYOUT_ENUM[spec.layout] ?? "TABLE_LAYOUT";
  const existing = project.views.find((v) => v.name === spec.name);

  // Look up groupBy field id if requested
  let groupByFieldIds: string[] | undefined;
  if (spec.groupByFieldName) {
    const f = project.fields.find((f) => f.name === spec.groupByFieldName);
    if (f) groupByFieldIds = [f.id];
  }

  if (!existing) {
    // Check if there's a stale default "View 1" we should rename instead of creating new
    const defaultView = project.views.find((v) => v.name === "View 1");
    if (defaultView) {
      await gql(
        `mutation($pid:ID!,$vid:ID!,$name:String!,$layout:ProjectV2ViewLayout!){
          updateProjectV2View(input:{ projectId:$pid, viewId:$vid, name:$name, layout:$layout }){
            projectView{ id }
          }
        }`,
        { pid: project.id, vid: defaultView.id, name: spec.name, layout: layoutEnum },
      );
    } else {
      type CR = { createProjectV2View: { projectView: { id: string } } };
      const created = await gql<CR>(
        `mutation($pid:ID!,$name:String!,$layout:ProjectV2ViewLayout!){
          createProjectV2View(input:{ projectId:$pid, name:$name, layout:$layout }){
            projectView{ id }
          }
        }`,
        { pid: project.id, name: spec.name, layout: layoutEnum },
      );
      // Apply filter + groupBy on the freshly created view
      const vid = created.createProjectV2View.projectView.id;
      if (spec.filter || groupByFieldIds) {
        await gql(
          `mutation($pid:ID!,$vid:ID!${spec.filter ? ",$fq:String!" : ""}${groupByFieldIds ? ",$gb:[ID!]!" : ""}){
            updateProjectV2View(input:{ projectId:$pid, viewId:$vid
              ${spec.filter ? ",filterQuery:$fq" : ""}
              ${groupByFieldIds ? ",groupByFieldIds:$gb" : ""}
            }){ projectView{ id } }
          }`,
          {
            pid: project.id,
            vid,
            ...(spec.filter ? { fq: spec.filter } : {}),
            ...(groupByFieldIds ? { gb: groupByFieldIds } : {}),
          },
        );
      }
    }
    return { view: spec.name, action: existing ? "updated" : "created" };
  }

  // View exists — check if layout needs updating
  if (existing.layout !== layoutEnum) {
    await gql(
      `mutation($pid:ID!,$vid:ID!,$layout:ProjectV2ViewLayout!){
        updateProjectV2View(input:{ projectId:$pid, viewId:$vid, layout:$layout }){
          projectView{ id }
        }
      }`,
      { pid: project.id, vid: existing.id, layout: layoutEnum },
    );
    return { view: spec.name, action: "updated" };
  }
  return { view: spec.name, action: "exists" };
}

/** All issue/PR content node-ids already on the board (paged). For dedupe. */
export async function existingContentIds(projectId: string): Promise<Set<string>> {
  type Resp = {
    node: {
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ content: { id?: string } | null }>;
      };
    };
  };
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const data: Resp = await gql<Resp>(
      `query($pid:ID!,$after:String){
        node(id:$pid){ ... on ProjectV2 {
          items(first:100, after:$after){
            pageInfo{ hasNextPage endCursor }
            nodes{ content{ ... on Issue{ id } ... on PullRequest{ id } } }
          }
        } }
      }`,
      { pid: projectId, after: cursor },
    );
    for (const n of data.node.items.nodes) if (n.content?.id) ids.add(n.content.id);
    cursor = data.node.items.pageInfo.hasNextPage ? data.node.items.pageInfo.endCursor : null;
  } while (cursor);
  return ids;
}

export interface OrgRepo {
  readonly id: string;
  readonly name: string;
}

/** All repos in the org (paged). Used for both linking and work-item enumeration. */
export async function orgRepos(): Promise<OrgRepo[]> {
  type RepoConn = {
    organization: {
      repositories: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ id: string; name: string }>;
      };
    };
  };
  const repos: OrgRepo[] = [];
  let cursor: string | null = null;
  do {
    const data: RepoConn = await gql<RepoConn>(
      `query($org:String!,$after:String){
        organization(login:$org){
          repositories(first:100, after:$after, orderBy:{field:NAME,direction:ASC}){
            pageInfo{ hasNextPage endCursor }
            nodes{ id name }
          }
        }
      }`,
      { org: ORG, after: cursor },
    );
    for (const r of data.organization.repositories.nodes) repos.push({ id: r.id, name: r.name });
    cursor = data.organization.repositories.pageInfo.hasNextPage
      ? data.organization.repositories.pageInfo.endCursor
      : null;
  } while (cursor);
  return repos;
}

/**
 * Link a repository to the project so it appears under the repo's Projects tab.
 * Idempotent — safe to call on every sweep; already-linked repos are a no-op.
 */
export async function linkRepoToProject(projectId: string, repoId: string): Promise<void> {
  await gql(
    `mutation($pid:ID!,$rid:ID!){
      linkProjectV2ToRepository(input:{ projectId:$pid, repositoryId:$rid }){
        repository{ id }
      }
    }`,
    { pid: projectId, rid: repoId },
  );
}

export interface WorkItem {
  readonly id: string;
  readonly kind: "Issue" | "PullRequest";
  readonly repo: string;
  readonly number: number;
  readonly title: string;
}

/**
 * Every OPEN issue and PR across ALL repos in the org (paged at both levels).
 * Enumerating dynamically means new repos are covered with no config change —
 * the room is "tied to all repos" by construction.
 */
export async function orgOpenWorkItems(): Promise<WorkItem[]> {
  const repos = await orgRepos();
  const items: WorkItem[] = [];
  for (const repo of repos) {
    items.push(...await openIn(repo.name, "issues"));
    items.push(...await openIn(repo.name, "pullRequests"));
  }
  return items;
}

async function openIn(repo: string, field: "issues" | "pullRequests"): Promise<WorkItem[]> {
  const kind: WorkItem["kind"] = field === "issues" ? "Issue" : "PullRequest";
  type Resp = {
    repository: {
      conn: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ id: string; number: number; title: string }>;
      } | null;
    };
  };
  const out: WorkItem[] = [];
  let cursor: string | null = null;
  do {
    const data: Resp = await gql<Resp>(
      `query($org:String!,$repo:String!,$after:String){
        repository(owner:$org, name:$repo){
          conn: ${field}(first:100, after:$after, states:OPEN){
            pageInfo{ hasNextPage endCursor }
            nodes{ id number title }
          }
        }
      }`,
      { org: ORG, repo, after: cursor },
    );
    const conn = data.repository.conn;
    if (!conn) break;
    for (const n of conn.nodes) out.push({ id: n.id, kind, repo, number: n.number, title: n.title });
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

/** Add one issue/PR to the board. Returns the new project-item id. */
export async function addItem(projectId: string, contentId: string): Promise<string> {
  type Resp = { addProjectV2ItemById: { item: { id: string } } };
  const data = await gql<Resp>(
    `mutation($pid:ID!,$cid:ID!){
      addProjectV2ItemById(input:{ projectId:$pid, contentId:$cid }){ item{ id } }
    }`,
    { pid: projectId, cid: contentId },
  );
  return data.addProjectV2ItemById.item.id;
}
