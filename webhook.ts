/**
 * @module
 * Front Desk instant webhook receiver — the "instant" half of the hybrid;
 * `sync.ts` is the daily backstop. The `bounded-systems-front-desk` GitHub App
 * is installed on ALL repos, so pointing its App-settings *Webhook URL* here and
 * subscribing to `Issues` + `Pull requests` lands every repo's opened/reopened
 * issue/PR on Front Desk instantly — no per-repo workflow, new repos covered
 * automatically (supersedes the per-repo `front-desk-add.yml`).
 *
 * Public/private contract (see @bounded-systems/trellis
 * docs/public-private-contract.md): this is the PUBLIC receiver — a private
 * repo's event is skipped here (it belongs to the private board), never
 * surfaced on the public board.
 *
 * Deploy-agnostic: Web Crypto only (no `node:*`), and `export default { fetch }`
 * so it runs as a Cloudflare Worker (deploy specced in the private `infra`
 * repo), on Deno Deploy, or locally via the `Deno.serve` wrapper below.
 *
 * Env / Worker bindings:
 *   GITHUB_WEBHOOK_SECRET        the App webhook secret (signature check)
 *   FRONT_DESK_APP_ID            the App id (mints installation tokens)
 *   FRONT_DESK_APP_PRIVATE_KEY   the App private key, PKCS#8 PEM
 *                                (`openssl pkcs8 -topk8 -nocrypt -in key.pem`)
 *   PORT                         local listen port (Deno wrapper only; def 8787)
 */

import {
  classifyKind,
  ORG,
  PROJECT_NUMBER,
  STATUS_FIELD,
  TYPE_FIELD,
} from "./contract.ts";

export interface Env {
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly FRONT_DESK_APP_ID: string;
  readonly FRONT_DESK_APP_PRIVATE_KEY: string;
}

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromString(s: string): string {
  return base64urlFromBytes(encoder.encode(s));
}

/** Constant-time string compare (equal-length short strings). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify GitHub's `X-Hub-Signature-256` over the raw body (Web Crypto HMAC). */
async function verifySignature(
  secret: string,
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return timingSafeEqual(`sha256=${toHex(mac)}`, signature);
}

/** Decode a PKCS#8 PEM private key to DER bytes. */
function pkcs8Der(pem: string): ArrayBuffer {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "FRONT_DESK_APP_PRIVATE_KEY is PKCS#1; convert to PKCS#8: " +
        "openssl pkcs8 -topk8 -nocrypt -in key.pem",
    );
  }
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(
    /\s+/g,
    "",
  );
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der.buffer as ArrayBuffer;
}

/** Mint a short-lived App JWT (RS256) for the installation-token exchange. */
async function appJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlFromString(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  );
  const payload = base64urlFromString(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(data),
  );
  return `${data}.${base64urlFromBytes(new Uint8Array(sig))}`;
}

/** Exchange the App JWT for an installation access token. */
async function installationToken(
  env: Env,
  installationId: number,
): Promise<string> {
  const jwt = await appJwt(
    env.FRONT_DESK_APP_ID,
    env.FRONT_DESK_APP_PRIVATE_KEY,
  );
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "gh-project-room",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `installation token mint failed: ${res.status} ${await res.text()}`,
    );
  }
  return ((await res.json()) as { token: string }).token;
}

async function gql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
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
    throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) throw new Error("GraphQL: no data");
  return body.data;
}

interface ProjectRef {
  readonly id: string;
  readonly kindFieldId: string | null;
  readonly kindOptions: ReadonlyMap<string, string>;
  readonly statusFieldId: string | null;
  readonly statusOptions: ReadonlyMap<string, string>;
}

/** Resolve Front Desk's node id and the Kind + Status fields/options. */
async function getProject(token: string): Promise<ProjectRef> {
  type FieldResp =
    | { id: string; options: Array<{ id: string; name: string }> }
    | null;
  type Resp = {
    organization: {
      projectV2: {
        id: string;
        kindField: FieldResp;
        statusField: FieldResp;
      };
    };
  };
  const data = await gql<Resp>(
    token,
    `query($org:String!,$num:Int!,$kind:String!,$status:String!){
      organization(login:$org){ projectV2(number:$num){
        id
        kindField: field(name:$kind){ ... on ProjectV2SingleSelectField { id options{ id name } } }
        statusField: field(name:$status){ ... on ProjectV2SingleSelectField { id options{ id name } } }
      } }
    }`,
    {
      org: ORG,
      num: PROJECT_NUMBER,
      kind: TYPE_FIELD.name,
      status: STATUS_FIELD.name,
    },
  );
  const p = data.organization.projectV2;
  return {
    id: p.id,
    kindFieldId: p.kindField?.id ?? null,
    kindOptions: new Map(
      (p.kindField?.options ?? []).map((o) => [o.name, o.id]),
    ),
    statusFieldId: p.statusField?.id ?? null,
    statusOptions: new Map(
      (p.statusField?.options ?? []).map((o) => [o.name, o.id]),
    ),
  };
}

async function addToBoard(
  token: string,
  projectId: string,
  contentId: string,
): Promise<string> {
  type Resp = { addProjectV2ItemById: { item: { id: string } } };
  const data = await gql<Resp>(
    token,
    `mutation($pid:ID!,$cid:ID!){
      addProjectV2ItemById(input:{ projectId:$pid, contentId:$cid }){ item{ id } }
    }`,
    { pid: projectId, cid: contentId },
  );
  return data.addProjectV2ItemById.item.id;
}

/** Set a single-select field value on a project item (Kind or Status). */
async function setSingleSelectValue(
  token: string,
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string,
): Promise<void> {
  await gql(
    token,
    `mutation($pid:ID!,$iid:ID!,$fid:ID!,$oid:String!){
      updateProjectV2ItemFieldValue(input:{
        projectId:$pid, itemId:$iid, fieldId:$fid, value:{ singleSelectOptionId:$oid }
      }){ projectV2Item{ id } }
    }`,
    { pid: projectId, iid: itemId, fid: fieldId, oid: optionId },
  );
}

/** The subset of a GitHub webhook payload this receiver reads. */
interface WebhookPayload {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string; private?: boolean };
  issue?: {
    node_id?: string;
    number?: number;
    labels?: Array<{ name: string }>;
  };
  pull_request?: { node_id?: string; number?: number };
}

export type TrackedAction = "opened" | "reopened" | "closed";

export interface ClassifiedEvent {
  readonly contentId: string;
  readonly kind: "Issue" | "PullRequest";
  readonly labels: string[];
  readonly action: TrackedAction;
}

/**
 * What the webhook acts on: issue/PR opened, reopened, or closed. Returns null
 * for anything else (draft/edited/labeled/etc. are ignored — the sweep is the
 * backstop for those).
 */
export function classify(
  event: string | null,
  p: WebhookPayload,
): ClassifiedEvent | null {
  const action = p.action;
  if (action !== "opened" && action !== "reopened" && action !== "closed") {
    return null;
  }
  if (event === "issues") {
    const id = p.issue?.node_id;
    if (!id) return null;
    return {
      contentId: id,
      kind: "Issue",
      labels: (p.issue?.labels ?? []).map((l) => l.name),
      action,
    };
  }
  if (event === "pull_request") {
    const id = p.pull_request?.node_id;
    if (!id) return null;
    return { contentId: id, kind: "PullRequest", labels: [], action };
  }
  return null;
}

/** Core request handler — the Worker/Deno-shared entrypoint. */
export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("ok");
  if (url.pathname !== "/api/github/webhooks" || req.method !== "POST") {
    return new Response("not found", { status: 404 });
  }

  // Reject oversized bodies BEFORE reading/HMACing them — a real GitHub webhook
  // payload is far under 1 MiB, so this caps the work an unauthenticated caller
  // can force (defense in depth; the signature is still the gate below).
  const MAX_BODY = 1_048_576;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
    return new Response("payload too large", { status: 413 });
  }

  const body = await req.text();
  if (body.length > MAX_BODY) {
    return new Response("payload too large", { status: 413 });
  }
  if (
    !await verifySignature(
      env.GITHUB_WEBHOOK_SECRET,
      body,
      req.headers.get("x-hub-signature-256"),
    )
  ) {
    return new Response("invalid signature", { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  const payload = JSON.parse(body) as WebhookPayload;
  const repo = payload.repository?.full_name ?? "?";

  // Public/private contract, FAIL CLOSED: only an explicitly public repo may
  // reach the public board. A missing/true `private` (or absent repository) is
  // skipped, so a private repo can never leak here on a malformed payload.
  if (payload.repository?.private !== false) {
    console.log(
      `[webhook] ${repo}: not confirmed public — skipped (visibility fail-closed)`,
    );
    return new Response("skipped (not public)");
  }

  const c = classify(event, payload);
  if (!c) return new Response("ignored");

  // installationId is interpolated into the token-mint URL — require a positive
  // integer so a malformed payload can't reshape that request (defense in depth;
  // the body is already signature-verified above).
  const installationId = payload.installation?.id;
  if (
    typeof installationId !== "number" || !Number.isInteger(installationId) ||
    installationId <= 0
  ) {
    return new Response("bad installation id", { status: 400 });
  }

  try {
    const token = await installationToken(env, installationId);
    const project = await getProject(token);
    // Idempotent: returns the existing item id if already on the board, so
    // close/reopen never creates a duplicate.
    const itemId = await addToBoard(token, project.id, c.contentId);

    let kindNote = "";
    if (c.action !== "closed") {
      const kind = classifyKind({ ...c, hasSubIssues: false });
      const optionId = project.kindFieldId
        ? project.kindOptions.get(kind)
        : undefined;
      if (project.kindFieldId && optionId) {
        await setSingleSelectValue(
          token,
          project.id,
          itemId,
          project.kindFieldId,
          optionId,
        );
        kindNote = ` [Kind→${kind}]`;
      }
    }

    // Status: "opened" relies on the board's native "Item added to project"
    // workflow (already sets Todo). closed/reopened have no such reliable
    // native equivalent (see docs/front-desk-charter.md's known gap), so this
    // is the code-owned, deterministic path for those two (#53).
    const statusName = c.action === "closed"
      ? "Done"
      : c.action === "reopened"
      ? "Todo"
      : null;
    if (statusName && project.statusFieldId) {
      const optionId = project.statusOptions.get(statusName);
      if (optionId) {
        await setSingleSelectValue(
          token,
          project.id,
          itemId,
          project.statusFieldId,
          optionId,
        );
      }
    }

    console.log(`[webhook] ${repo}: ${c.action} ${c.kind}${kindNote}`);
    return new Response(c.action);
  } catch (e) {
    // Log and 200 so GitHub doesn't hammer retries; the daily sweep backstops.
    console.error(`[webhook] ${repo}: ${e instanceof Error ? e.message : e}`);
    return new Response("deferred to sweep");
  }
}

/** Cloudflare Worker entrypoint (deploy specced in the private `infra` repo). */
export default {
  fetch: (req: Request, env: Env): Promise<Response> => handleRequest(req, env),
};

// Local run: `deno run --allow-net --allow-env webhook.ts`
if (import.meta.main) {
  const env: Env = {
    GITHUB_WEBHOOK_SECRET: Deno.env.get("GITHUB_WEBHOOK_SECRET") ?? "",
    FRONT_DESK_APP_ID: Deno.env.get("FRONT_DESK_APP_ID") ?? "",
    FRONT_DESK_APP_PRIVATE_KEY: Deno.env.get("FRONT_DESK_APP_PRIVATE_KEY") ??
      "",
  };
  const port = Number(Deno.env.get("PORT") ?? 8787);
  Deno.serve({ port }, (req) => handleRequest(req, env));
}
