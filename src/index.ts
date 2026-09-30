/**
 * github-mcp-worker — exposes the GitHub REST / GraphQL API as a remote MCP server (Streamable HTTP) on Cloudflare Workers.
 * An alternative to hosted GitHub connectors where you control tool granularity, output size and write operations.
 *
 *   MCP client (claude.ai custom connector, Claude Code, ...)
 *     → https://<your-host>/mcp       Cloudflare Access (Managed OAuth; unauthenticated → 401 + Access OAuth discovery)
 *       → the Worker verifies Cf-Access-Jwt-Assertion, calls api.github.com with GITHUB_TOKEN (PAT) and returns trimmed results
 *
 * Design:
 *   - Stateless (no Mcp-Session-Id; each POST is an independent JSON-RPC call; no SSE)
 *   - Authentication is Cloudflare Access only. Access handles OAuth; the Worker verifies the Access JWT (aud / iss / signature). The Worker never sends WWW-Authenticate itself
 *   - Until GITHUB_TOKEN is set, only gh_status is exposed (unconfigured mode)
 */
import { verifyAccessJwt } from "./access.ts";
import { type Env, createClient } from "./github.ts";
import { TOOLS, callTool } from "./tools.ts";

export type { Env };

const SERVER_NAME = "github-mcp";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

type JsonRpcId = number | string | null;
type JsonRpcReq = { jsonrpc?: "2.0"; id?: JsonRpcId; method?: string; params?: unknown };

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function instructions(env: Env): string {
  const owner = env.DEFAULT_OWNER ? `Default owner is '${env.DEFAULT_OWNER}' (omit owner, or pass repo as 'owner/name').` : "";
  return [
    "GitHub as MCP tools (gh_*), backed by a single personal access token.",
    owner,
    "Start with gh_repo_get / gh_tree / gh_file_get to read code, gh_issues_list / gh_prs_list for tracking, gh_checks / gh_actions_run_logs_failed for CI.",
    "Writes: gh_file_put (1 file), gh_push_files (many files, one commit), gh_issue_create/update, gh_pr_create/merge/review.",
    "Anything else: gh_api (REST, any path) or gh_graphql. Outputs are trimmed; raise max_chars when you need more.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function handleRpc(req: JsonRpcReq, env: Env): Promise<unknown | undefined> {
  const { id, method, params } = req;
  if (!method || req.jsonrpc !== "2.0") return rpcError(id, -32600, "Invalid Request");
  if (method.startsWith("notifications/")) return undefined; // no response for notifications
  const configured = Boolean(env.GITHUB_TOKEN);
  switch (method) {
    case "initialize": {
      const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: requested && SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: configured ? SERVER_NAME : `${SERVER_NAME} (unconfigured)`, version: SERVER_VERSION },
        instructions: configured
          ? instructions(env)
          : "github-mcp: GITHUB_TOKEN is not configured yet, so only gh_status is available. Call it for setup steps.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list": {
      const tools = (configured ? TOOLS : TOOLS.filter((t) => t.name === "gh_status")).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      return rpcResult(id, { tools });
    }
    case "tools/call": {
      const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (!p.name) return rpcError(id, -32602, "tools/call requires params.name");
      if (!configured && p.name !== "gh_status") return rpcError(id, -32602, `Unknown tool: ${p.name} (GITHUB_TOKEN not configured)`);
      const result = await callTool(p.name, p.arguments ?? {}, { gh: createClient(env), env });
      return rpcResult(id, result);
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "resources/templates/list":
      return rpcResult(id, { resourceTemplates: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    case "completion/complete":
      return rpcResult(id, { completion: { values: [] } });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function serveMcp(request: Request, env: Env): Promise<Response> {
  const mode = env.GITHUB_TOKEN ? "ready" : "unconfigured";
  const baseHeaders: Record<string, string> = { "cache-control": "no-store", "x-github-mcp-mode": mode };
  if (request.method === "GET") {
    // No server-initiated SSE stream (optional in Streamable HTTP)
    return new Response(null, { status: 405, headers: { ...baseHeaders, allow: "POST, DELETE" } });
  }
  if (request.method === "DELETE") return new Response(null, { status: 200, headers: baseHeaders });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { ...baseHeaders, allow: "POST, DELETE" } });

  const headers = { ...baseHeaders, "content-type": "application/json" };
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers });
  }
  const reqs = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcReq[];
  const responses: unknown[] = [];
  for (const r of reqs) {
    try {
      const out = await handleRpc(r, env);
      if (out !== undefined) responses.push(out);
    } catch (e) {
      responses.push(rpcError(r?.id, -32603, `Internal error: ${(e as Error).message}`));
    }
  }
  if (responses.length === 0) return new Response(null, { status: 202, headers: baseHeaders });
  return new Response(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]), { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/" || pathname === "/health") {
      return new Response("github-mcp ok\n", { headers: { "content-type": "text/plain", "x-github-mcp-mode": env.GITHUB_TOKEN ? "ready" : "unconfigured" } });
    }
    if (pathname !== "/mcp" && pathname !== "/mcp/") return new Response("Not found", { status: 404 });
    // Reject anything that did not pass Access (fail closed when configuration is missing)
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return new Response("Access is not configured", { status: 500 });
    const jwt = request.headers.get("cf-access-jwt-assertion");
    if (!jwt) return new Response("Forbidden", { status: 403 });
    try {
      await verifyAccessJwt(jwt, { team: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    return serveMcp(request, env);
  },
} satisfies ExportedHandler<Env>;
