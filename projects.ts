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
  type WorkflowSpec,
} from "./contract.ts";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

function token(): string {
  const t = Deno.env.get("GITHUB_TOKEN");
  if (!t) {
    throw new Error("GITHUB_TOKEN is not set (mint the App token first).");
  }
  return t;
}

/** Minimal typed GraphQL caller. Throws on transport or GraphQL errors. */
async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
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
  const body = await res.json() as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(
      `GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
    );
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
export interface ExistingWorkflow {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}
export interface Project {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly ExistingField[];
  readonly views: readonly ExistingView[];
  readonly workflows: readonly ExistingWorkflow[];
}

/** Resolve Front Desk (org project #2) → node id, title, fields, views, and workflows. */
export async function getProject(): Promise<Project> {
  type Resp = {
    organization: {
      projectV2: {
        id: string;
        title: string;
        fields: {
          nodes: Array<
            {
              id: string;
              name: string;
              dataType: string;
              options?: ExistingOption[];
            }
          >;
        };
        views: {
          nodes: Array<{ id: string; name: string; layout: string }>;
        };
        workflows: {
          nodes: Array<{ id: string; name: string; enabled: boolean }>;
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
          workflows(first:50){ nodes{ id name enabled } }
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
    views: p.views.nodes.map((v) => ({
      id: v.id,
      name: v.name,
      layout: v.layout,
    })),
    workflows: (p.workflows?.nodes ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      enabled: w.enabled,
    })),
  };
}

function singleSelectOptionsLiteral(field: SingleSelectFieldSpec): string {
  return field.options
    .map((o) =>
      `{name:${JSON.stringify(o.name)},color:${o.color},description:${
        JSON.stringify(o.description)
      }}`
    )
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
export async function applyField(
  project: Project,
  spec: FieldSpec,
): Promise<ApplyResult> {
  const existing = project.fields.find((f) => f.name === spec.name);

  if (!existing) {
    if (spec.kind === "SINGLE_SELECT") {
      await gql(
        `mutation($pid:ID!){
          createProjectV2Field(input:{
            projectId:$pid, dataType:SINGLE_SELECT, name:${
          JSON.stringify(spec.name)
        },
            singleSelectOptions:[${singleSelectOptionsLiteral(spec)}]
          }){ projectV2Field{ ... on ProjectV2SingleSelectField{ id } } }
        }`,
        { pid: project.id },
      );
    } else {
      // spec.kind is "TEXT" | "DATE" | "NUMBER" here — all are valid
      // ProjectV2CustomFieldType enum values, so the dataType interpolates directly.
      await gql(
        `mutation($pid:ID!){
          createProjectV2Field(input:{ projectId:$pid, dataType:${spec.kind}, name:${
          JSON.stringify(spec.name)
        } }){
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
    const missing = spec.options.filter((o) => !have.has(o.name.toLowerCase()))
      .map((o) => o.name);
    if (missing.length) {
      return {
        field: spec.name,
        action: "needs-manual",
        missingOptions: missing,
      };
    }
  }
  return { field: spec.name, action: "exists" };
}

export type ViewCheckResult = { view: string; action: "exists" | "missing" };

/**
 * Pure predicate: does a view spec's name appear among existing view names?
 * Decoupled from the GraphQL `Project` shape so it can be driven by any list
 * of names — e.g. a VerbSpec verb's plain-JSON input (see verbs.ts).
 */
export function viewExists(
  existingViewNames: readonly string[],
  spec: import("./contract.ts").ViewSpec,
): ViewCheckResult {
  const exists = existingViewNames.includes(spec.name);
  return { view: spec.name, action: exists ? "exists" : "missing" };
}

/**
 * Check whether a view exists on the project. Returns "exists" or "missing".
 * GitHub Projects v2 does not expose createProjectV2View / updateProjectV2View
 * mutations in the public API — views must be created and configured via the
 * UI. This function is read-only: it reports drift for manual action.
 */
export function checkView(
  project: Project,
  spec: import("./contract.ts").ViewSpec,
): ViewCheckResult {
  return viewExists(project.views.map((v) => v.name), spec);
}

export type WorkflowResult =
  | { workflow: string; action: "ok" }
  | { workflow: string; action: "drift"; live: boolean; want: boolean }
  | { workflow: string; action: "not-found" };

export interface ExistingWorkflowState {
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * Pure predicate: does a workflow spec's enabled state match the live board?
 * Decoupled from the GraphQL `Project` shape — e.g. a VerbSpec verb's
 * plain-JSON input (see verbs.ts).
 */
export function workflowStatus(
  existingWorkflows: readonly ExistingWorkflowState[],
  spec: WorkflowSpec,
): WorkflowResult {
  const existing = existingWorkflows.find((w) => w.name === spec.name);
  if (!existing) return { workflow: spec.name, action: "not-found" };
  if (existing.enabled === spec.enabled) {
    return { workflow: spec.name, action: "ok" };
  }
  return {
    workflow: spec.name,
    action: "drift",
    live: existing.enabled,
    want: spec.enabled,
  };
}

/**
 * Check one workflow spec against the live project (read-only).
 * GitHub Projects v2 has no `updateProjectV2Workflow` mutation in the public
 * API — the same situation as views. Reports "ok" when in sync, "drift" when
 * not (for manual action in the UI), and "not-found" when the workflow name
 * doesn't appear on the project (name mismatch or plan difference).
 */
export function checkWorkflow(
  project: Project,
  spec: WorkflowSpec,
): WorkflowResult {
  return workflowStatus(
    project.workflows.map((w) => ({ name: w.name, enabled: w.enabled })),
    spec,
  );
}

/** All issue/PR content node-ids already on the board (paged). For dedupe. */
export async function existingContentIds(
  projectId: string,
): Promise<Set<string>> {
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
    for (const n of data.node.items.nodes) {
      if (n.content?.id) ids.add(n.content.id);
    }
    cursor = data.node.items.pageInfo.hasNextPage
      ? data.node.items.pageInfo.endCursor
      : null;
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
    for (const r of data.organization.repositories.nodes) {
      repos.push({ id: r.id, name: r.name });
    }
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
export async function linkRepoToProject(
  projectId: string,
  repoId: string,
): Promise<void> {
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
  /** Label names — drives Kind classification (#51). */
  readonly labels: readonly string[];
  /** True when an issue has native sub-issues (an epic signal for #51). */
  readonly hasSubIssues: boolean;
}

/** One repo the sweep could not fully read, with the error that stopped it. */
export interface SkippedRepo {
  readonly repo: string;
  readonly reason: string;
}

/**
 * The result of enumerating org work items: the items that were readable, plus
 * any repos that could not be read. Partial by design — a single unreadable
 * repo must never abort the whole reconcile (that broke the central sweep:
 * one "Resource not accessible by integration" aborted every add).
 */
export interface OrgWorkItems {
  readonly items: WorkItem[];
  readonly skipped: SkippedRepo[];
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Every OPEN issue and PR across ALL repos in the org (paged at both levels).
 * Enumerating dynamically means new repos are covered with no config change —
 * the room is "tied to all repos" by construction.
 *
 * Resilient: each repo is read independently. If its issues query fails, it is
 * retried WITHOUT the gated `subIssues` field before giving up; a repo that
 * still fails is recorded in `skipped` and the sweep continues. So the board
 * gets every readable repo's items even when one repo is inaccessible.
 */
export async function orgOpenWorkItems(): Promise<OrgWorkItems> {
  const repos = await orgRepos();
  const items: WorkItem[] = [];
  const skipped: SkippedRepo[] = [];
  for (const repo of repos) {
    try {
      try {
        items.push(...await openIn(repo.name, "issues"));
      } catch {
        // Most likely the gated `subIssues` field — retry without it so the
        // items still land (only the epic auto-classify signal is lost).
        items.push(...await openIn(repo.name, "issues", false));
      }
      items.push(...await openIn(repo.name, "pullRequests"));
    } catch (e) {
      skipped.push({ repo: repo.name, reason: errMessage(e) });
    }
  }
  return { items, skipped };
}

async function openIn(
  repo: string,
  field: "issues" | "pullRequests",
  withSubIssues = true,
): Promise<WorkItem[]> {
  const kind: WorkItem["kind"] = field === "issues" ? "Issue" : "PullRequest";
  // Only Issue has subIssues; the shared query string is reused for both
  // connections, so the field is omitted for pull requests. `subIssues` is a
  // newer, gated GitHub field that can throw "Resource not accessible by
  // integration" under some App tokens — orgOpenWorkItems retries without it
  // (withSubIssues=false) so one gated field never aborts the whole sweep.
  const subIssuesSel = field === "issues" && withSubIssues
    ? "subIssues(first:0){ totalCount }"
    : "";
  type Resp = {
    repository: {
      conn: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          number: number;
          title: string;
          labels: { nodes: Array<{ name: string }> } | null;
          subIssues?: { totalCount: number };
        }>;
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
            nodes{ id number title labels(first:20){ nodes{ name } } ${subIssuesSel} }
          }
        }
      }`,
      { org: ORG, repo, after: cursor },
    );
    const conn = data.repository.conn;
    if (!conn) break;
    for (const n of conn.nodes) {
      out.push({
        id: n.id,
        kind,
        repo,
        number: n.number,
        title: n.title,
        labels: (n.labels?.nodes ?? []).map((l) => l.name),
        hasSubIssues: (n.subIssues?.totalCount ?? 0) > 0,
      });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

/** Field values extracted from a single board item (for score write-back). */
export interface BoardItemFields {
  readonly status: string | null;
  readonly kind: string | null;
  readonly effort: number | null;
  readonly value: number | null;
  readonly dependsOn: string | null;
  readonly score: number | null;
}

/** A project item with its current field values. */
export interface BoardItem {
  /** ProjectV2Item node id — used as `itemId` in field-value mutations. */
  readonly itemId: string;
  /** Underlying Issue / PR node id. */
  readonly contentId: string;
  /** Issue / PR number (repo-scoped). */
  readonly number: number;
  readonly fields: BoardItemFields;
}

/**
 * All items currently on the board, each with the six field values needed for
 * score computation. Used by the score write-back step in sync.ts (#7).
 *
 * Draft issues (no content id or number) are silently skipped — they cannot
 * be scored against a GitHub issue number.
 */
export async function boardItems(projectId: string): Promise<BoardItem[]> {
  type FieldNode = {
    field?: { name: string };
    name?: string | null; // SINGLE_SELECT
    number?: number | null; // NUMBER
    text?: string | null; // TEXT
  };
  type Resp = {
    node: {
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          content: { id?: string; number?: number } | null;
          fieldValues: { nodes: FieldNode[] };
        }>;
      };
    };
  };
  const items: BoardItem[] = [];
  let cursor: string | null = null;
  do {
    const data: Resp = await gql<Resp>(
      `query($pid:ID!,$after:String){
        node(id:$pid){ ... on ProjectV2{
          items(first:100,after:$after){
            pageInfo{ hasNextPage endCursor }
            nodes{
              id
              content{
                ... on Issue{ id number }
                ... on PullRequest{ id number }
              }
              fieldValues(first:20){ nodes{
                ... on ProjectV2ItemFieldSingleSelectValue{
                  field{ ... on ProjectV2FieldCommon{ name } } name
                }
                ... on ProjectV2ItemFieldNumberValue{
                  field{ ... on ProjectV2FieldCommon{ name } } number
                }
                ... on ProjectV2ItemFieldTextValue{
                  field{ ... on ProjectV2FieldCommon{ name } } text
                }
              } }
            }
          }
        } }
      }`,
      { pid: projectId, after: cursor },
    );
    for (const n of data.node.items.nodes) {
      if (!n.content?.id || n.content.number == null) continue;
      const fvMap = new Map<string, FieldNode>();
      for (const fv of n.fieldValues.nodes) {
        if (fv.field?.name) fvMap.set(fv.field.name, fv);
      }
      items.push({
        itemId: n.id,
        contentId: n.content.id,
        number: n.content.number,
        fields: {
          status: fvMap.get("Status")?.name ?? null,
          kind: fvMap.get("Kind")?.name ?? null,
          effort: fvMap.get("Effort")?.number ?? null,
          value: fvMap.get("Value")?.number ?? null,
          dependsOn: fvMap.get("Depends on")?.text ?? null,
          score: fvMap.get("Score")?.number ?? null,
        },
      });
    }
    cursor = data.node.items.pageInfo.hasNextPage
      ? data.node.items.pageInfo.endCursor
      : null;
  } while (cursor);
  return items;
}

/** Add one issue/PR to the board. Returns the new project-item id. */
export async function addItem(
  projectId: string,
  contentId: string,
): Promise<string> {
  type Resp = { addProjectV2ItemById: { item: { id: string } } };
  const data = await gql<Resp>(
    `mutation($pid:ID!,$cid:ID!){
      addProjectV2ItemById(input:{ projectId:$pid, contentId:$cid }){ item{ id } }
    }`,
    { pid: projectId, cid: contentId },
  );
  return data.addProjectV2ItemById.item.id;
}

/** Set a NUMBER field value on a project item (e.g. Score write-back, #7). */
export async function setNumberValue(
  projectId: string,
  itemId: string,
  fieldId: string,
  value: number,
): Promise<void> {
  await gql(
    `mutation($pid:ID!,$iid:ID!,$fid:ID!,$val:Float!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$pid, itemId:$iid, fieldId:$fid,
        value:{ number:$val }
      }){ projectV2Item{ id } }
    }`,
    { pid: projectId, iid: itemId, fid: fieldId, val: value },
  );
}

/**
 * Set a single-select field value on a project item — used to auto-set `Kind`
 * on freshly added items (#51).
 *
 * The caller only invokes this for items it just added, so a manually-chosen
 * value on an existing item is never overwritten (re-runs skip on-board items).
 */
export async function setSingleSelectValue(
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string,
): Promise<void> {
  await gql(
    `mutation($pid:ID!,$iid:ID!,$fid:ID!,$oid:String!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$pid, itemId:$iid, fieldId:$fid,
        value:{ singleSelectOptionId:$oid }
      }){ projectV2Item{ id } }
    }`,
    { pid: projectId, iid: itemId, fid: fieldId, oid: optionId },
  );
}
