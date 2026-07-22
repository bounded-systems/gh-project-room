/**
 * @module
 * scout-reads.ts — the scout-backed `BoardReads` adapter.
 *
 * The second adapter behind the `reads.ts` seam. Where `directReads` talks to
 * the GitHub GraphQL API with a token in hand, `scoutReads` holds no token: it
 * routes each read through the **scout door** (door-kit → scoutd) over the
 * guest-room NDJSON protocol, so the real request is governed (`github-budget`)
 * and content-addressed + invalidated (`cas` + `anchored-chain`) by the layer
 * behind the door. This repo still never caches — that stays the scout layer's
 * job (see docs/reads-through-scout.md).
 *
 * Inject it in place of `directReads` for **in-box** runs (e.g. the `ready`
 * verb reached from Claude Code / mobile), where a `--scout` door is mounted.
 * The production sweep (`front-desk-sync.yml`) runs in GitHub Actions, can't
 * reach `scoutd`, and keeps `directReads`.
 *
 * Wire: scout-wire 0.3.0 verbs `project` / `repos` / `orgOpenWork` /
 * `orgMergedPrs`. scoutd reports a repo as `owner/name` (nameWithOwner); this
 * repo's types use the bare repo name, so the mappers strip the owner to keep
 * the two adapters shape-identical.
 *
 * `getProject` is board-read-only here: scout's `project` verb returns items,
 * not the project's field/view/workflow schema, so this adapter can back the
 * read/rank paths (`ready`) but NOT sync's field reconciliation — which is why
 * sync stays on `directReads`.
 */

import { ORG, PROJECT_NUMBER } from "./contract.ts";
import type {
  BoardItem,
  OrgMergedPRs,
  OrgRepo,
  OrgWorkItems,
  Project,
} from "./projects.ts";
import type { BoardReads } from "./reads.ts";

// ── Wire shapes (scout-wire 0.3.0 verb outputs) ──────────────────────────────

/** One item as scoutd's `project` verb returns it. */
interface ScoutProjectItem {
  number: number;
  title: string;
  url: string;
  repo: string;
  contentType: "Issue" | "PullRequest";
  state: "OPEN" | "CLOSED" | "MERGED";
  contentId: string;
  itemId: string;
  createdAt: string;
  isPrivate: boolean;
  fields: Record<string, string | number>;
}
interface ScoutProjectOutput {
  items: ScoutProjectItem[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface ScoutReposOutput {
  repos: Array<{ id: string; name: string; isPrivate: boolean }>;
}
interface ScoutOrgOpenWorkOutput {
  items: Array<{
    id: string;
    kind: "Issue" | "PullRequest";
    repo: string;
    number: number;
    title: string;
    labels: string[];
    hasSubIssues: boolean;
  }>;
  skipped: Array<{ repo: string; reason: string }>;
}
interface ScoutOrgMergedPrsOutput {
  items: Array<{
    repo: string;
    number: number;
    title: string;
    authorLogin: string | null;
    labels: string[];
    closingIssueCount: number;
  }>;
  skipped: Array<{ repo: string; reason: string }>;
}

// ── Pure mappers (network-free, unit-tested) ─────────────────────────────────

/** scoutd reports `owner/name`; this repo's types carry the bare repo name. */
export function bareRepo(nameWithOwner: string): string {
  const slash = nameWithOwner.lastIndexOf("/");
  return slash === -1 ? nameWithOwner : nameWithOwner.slice(slash + 1);
}

const asStr = (v: string | number | undefined): string | null =>
  typeof v === "string" ? v : null;
const asNum = (v: string | number | undefined): number | null =>
  typeof v === "number" ? v : null;

/** scout `project` item → this repo's `BoardItem`. Field names match the board
 *  (Status/Kind/Effort/Value/"Depends on"/Score), exactly as `boardItems` reads
 *  them, so scores never drift between the two adapters. */
export function toBoardItem(it: ScoutProjectItem): BoardItem {
  return {
    itemId: it.itemId,
    contentId: it.contentId,
    number: it.number,
    repo: bareRepo(it.repo),
    isPrivate: it.isPrivate,
    ghState: it.state,
    createdAt: it.createdAt,
    fields: {
      status: asStr(it.fields.Status),
      kind: asStr(it.fields.Kind),
      effort: asNum(it.fields.Effort),
      value: asNum(it.fields.Value),
      dependsOn: asStr(it.fields["Depends on"]),
      score: asNum(it.fields.Score),
    },
  };
}

/** scout `repos` output → `OrgRepo[]`, fail-closed on visibility (parity with
 *  `directReads.orgRepos`): only an explicitly-public repo reaches the public
 *  board unless `includePrivate`. */
export function toOrgRepos(
  out: ScoutReposOutput,
  includePrivate: boolean,
): OrgRepo[] {
  return out.repos
    .filter((r) => includePrivate || r.isPrivate === false)
    .map((r) => ({ id: r.id, name: r.name, isPrivate: r.isPrivate }));
}

/** scout `orgOpenWork` output → `OrgWorkItems`. */
export function toOrgWorkItems(out: ScoutOrgOpenWorkOutput): OrgWorkItems {
  return {
    items: out.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      repo: bareRepo(i.repo),
      number: i.number,
      title: i.title,
      labels: i.labels,
      hasSubIssues: i.hasSubIssues,
    })),
    skipped: out.skipped.map((s) => ({
      repo: bareRepo(s.repo),
      reason: s.reason,
    })),
  };
}

/** scout `orgMergedPrs` output → `OrgMergedPRs`. */
export function toOrgMergedPRs(out: ScoutOrgMergedPrsOutput): OrgMergedPRs {
  return {
    items: out.items.map((i) => ({
      repo: bareRepo(i.repo),
      number: i.number,
      title: i.title,
      authorLogin: i.authorLogin,
      labels: i.labels,
      closingIssueCount: i.closingIssueCount,
    })),
    skipped: out.skipped.map((s) => ({
      repo: bareRepo(s.repo),
      reason: s.reason,
    })),
  };
}

// ── Transport (Deno → scoutd, guest-room NDJSON) ─────────────────────────────

/** A scout-door RPC failure, carrying scoutd's machine-readable code. */
export class ScoutReadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ScoutReadError";
  }
}

/** Resolve scoutd's endpoint: `SCOUTD_HOST` (host:port) wins, else `SCOUTD_SOCK`
 *  (a unix path OR host:port), else the in-box default socket. Mirrors door-kit's
 *  `scoutEndpoint()`. */
function scoutEndpoint(): string {
  return Deno.env.get("SCOUTD_HOST") ??
    Deno.env.get("SCOUTD_SOCK") ??
    "/run/scoutd.sock";
}

/** A leading "/" (optionally `unix://`) is a unix socket; otherwise `host:port`
 *  (optionally `tcp://`) is TCP. A path containing ":" stays unix. Mirrors the
 *  guest-room `connectTarget`. Tagged so the caller can pick one Deno.connect
 *  overload (passing the raw union defeats overload selection). */
type ConnectTarget =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; hostname: string; port: number };

function connectTarget(endpoint: string): ConnectTarget {
  const stripped = endpoint.replace(/^unix:\/\//, "");
  if (!stripped.startsWith("/")) {
    const m = stripped.replace(/^tcp:\/\//, "").match(/^([^/\s]+):(\d{1,5})$/);
    if (m) return { kind: "tcp", hostname: m[1]!, port: Number(m[2]) };
  }
  return { kind: "unix", path: stripped };
}

/** Send one request to scoutd and await its response (one connection per call,
 *  matching the guest-room client). On a unix socket the kernel authenticates
 *  the peer, so no grant is presented. */
async function scoutCall<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const target = connectTarget(scoutEndpoint());
  let conn: Deno.Conn;
  try {
    // Branch on the tag so each Deno.connect call matches one overload (unix
    // vs tcp) — passing the raw union defeats overload selection.
    conn = target.kind === "unix"
      ? await Deno.connect({ transport: "unix", path: target.path })
      : await Deno.connect({ hostname: target.hostname, port: target.port });
  } catch (e) {
    throw new ScoutReadError(
      "CONNECTION_ERROR",
      `failed to connect to scoutd: ${e}`,
    );
  }

  try {
    const req = { id: crypto.randomUUID(), method, params };
    await conn.write(new TextEncoder().encode(JSON.stringify(req) + "\n"));

    const decoder = new TextDecoder();
    let buffer = "";
    const chunk = new Uint8Array(64 * 1024);
    while (!buffer.includes("\n")) {
      const n = await conn.read(chunk);
      if (n === null) {
        throw new ScoutReadError(
          "CONNECTION_CLOSED",
          "scoutd closed before responding",
        );
      }
      buffer += decoder.decode(chunk.subarray(0, n), { stream: true });
    }

    const line = buffer.slice(0, buffer.indexOf("\n"));
    let resp: {
      ok: boolean;
      result?: unknown;
      error?: { code: string; message: string };
    };
    try {
      resp = JSON.parse(line);
    } catch {
      throw new ScoutReadError("PARSE_ERROR", "invalid response from scoutd");
    }
    if (!resp.ok) {
      throw new ScoutReadError(
        resp.error?.code ?? "UNKNOWN",
        resp.error?.message ?? "unknown scoutd error",
      );
    }
    return resp.result as T;
  } finally {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
}

/** Page through scout's `project` verb, accumulating every board item. */
async function allProjectItems(): Promise<ScoutProjectItem[]> {
  const items: ScoutProjectItem[] = [];
  let after: string | undefined;
  do {
    const page = await scoutCall<ScoutProjectOutput>("project", {
      org: ORG,
      number: PROJECT_NUMBER,
      first: 100,
      after,
    });
    items.push(...page.items);
    after = page.pageInfo.hasNextPage
      ? page.pageInfo.endCursor ?? undefined
      : undefined;
  } while (after);
  return items;
}

// ── The adapter ──────────────────────────────────────────────────────────────

/**
 * The scout-backed `BoardReads`. A drop-in for `directReads` on an in-box run
 * with a `--scout` door. Holds no token; each method is one (or a few) scout
 * calls mapped into this repo's read types.
 */
export const scoutReads: BoardReads = {
  /**
   * Board-read-only: scout's `project` verb returns items, not the project
   * schema, so `fields`/`views`/`workflows` are empty and `id` is a synthetic
   * `org#number` handle (which `boardItems` here ignores — it addresses the
   * board by `org`+`number`, not a node id). Enough for the read/rank paths;
   * NOT enough for sync's field reconciliation.
   */
  getProject(): Promise<Project> {
    return Promise.resolve({
      id: `scout:${ORG}#${PROJECT_NUMBER}`,
      title: "Front Desk",
      fields: [],
      views: [],
      workflows: [],
    });
  },

  /** Every board item, paged through scout's `project` verb and mapped 1:1 to
   *  `BoardItem` (the same field names `boardItems` reads, so scores match). The
   *  `_projectId` is ignored — scout addresses the board by `org`+`number`. */
  async boardItems(_projectId: string): Promise<BoardItem[]> {
    const items = await allProjectItems();
    // Parity with directReads: drop draft items (no content id / number). scout
    // already filters these, but keep the guard so the two adapters agree.
    return items
      .filter((it) => it.contentId && it.number != null)
      .map(toBoardItem);
  },

  /** Content ids already on the board — derived from the same project read
   *  (no separate verb needed). */
  async existingContentIds(_projectId: string): Promise<Set<string>> {
    const items = await allProjectItems();
    return new Set(items.map((it) => it.contentId).filter(Boolean));
  },

  /** Every open issue/PR across the org via scout's `orgOpenWork` verb. */
  async orgOpenWorkItems(): Promise<OrgWorkItems> {
    const out = await scoutCall<ScoutOrgOpenWorkOutput>("orgOpenWork", {
      org: ORG,
    });
    return toOrgWorkItems(out);
  },

  /** Every merged PR across the org via scout's `orgMergedPrs` verb. */
  async orgMergedPullRequests(): Promise<OrgMergedPRs> {
    const out = await scoutCall<ScoutOrgMergedPrsOutput>("orgMergedPrs", {
      org: ORG,
    });
    return toOrgMergedPRs(out);
  },

  /** Every org repo via scout's `repos` verb, fail-closed on visibility. */
  async orgRepos(includePrivate = false): Promise<OrgRepo[]> {
    const out = await scoutCall<ScoutReposOutput>("repos", {
      org: ORG,
      includePrivate,
    });
    return toOrgRepos(out, includePrivate);
  },
};
