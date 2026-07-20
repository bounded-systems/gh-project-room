/**
 * @module
 * Front Desk MCP server — projects this repo's `VERBS` registry (verbs.ts) as
 * MCP tools over stdio. The org-standard shape: verbspec verbs → the
 * `@bounded-systems/verbspec-mcp` base → a server ("hand it a registry, get a
 * server"). Each verb becomes one tool:
 *   - `ready`         — the ranked "what should I work on next?" queue (reads
 *                       the live board; needs a read-only GITHUB_TOKEN).
 *   - `classify-kind` / `check-view` / `check-workflow` — pure contract checks.
 *
 * Run (stdio):  deno run --allow-net=api.github.com --allow-env mcp.ts
 * Env:  GITHUB_TOKEN — only the `ready` tool's read needs it; the server starts
 *       without one and fails that single tool call if it's absent.
 *
 * A local MCP client (Claude Desktop / Claude Code) launches this command with
 * GITHUB_TOKEN in its env. Reaching it from the Claude mobile app needs a remote
 * HTTP transport in front of the same server (buildMcpServer) plus a host + auth
 * — a deploy step, tracked separately.
 */

import { serveStdio } from "@bounded-systems/verbspec-mcp";
import denoConfig from "./deno.json" with { type: "json" };
import { VERBS } from "./verbs.ts";

if (import.meta.main) {
  await serveStdio(VERBS, {
    name: "front-desk",
    version: denoConfig.version,
    instructions:
      "Front Desk is the org's single prioritization board. Call `ready` to get " +
      "the ranked queue of what to work on next (top eligible items by Score, " +
      "with the signal breakdown); the check-* verbs report board-contract drift.",
  });
}
