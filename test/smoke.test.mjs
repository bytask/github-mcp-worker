// Smoke tests against a deployed Worker.
//   MCP_URL=https://<your-host>/mcp npm test          → only checks that unauthenticated requests get Access's 401 (Managed OAuth)
//   add MCP_TOKEN=<OAuth access token issued by Access> to call the MCP server
//   add GITHUB_MCP_SMOKE_REPO=owner/repo to exercise read tools too (requires GITHUB_TOKEN to be set)
// Node's fetch ignores HTTPS_PROXY; behind a proxy, add NODE_USE_ENV_PROXY=1.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.MCP_URL;
const token = process.env.MCP_TOKEN;
const smokeRepo = process.env.GITHUB_MCP_SMOKE_REPO;
let seq = 0;

async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
  });
  assert.equal(res.status, 200, `${method} → HTTP ${res.status}`);
  const body = await res.json();
  assert.equal(body.error, undefined, `${method} → ${JSON.stringify(body.error)}`);
  return { result: body.result, mode: res.headers.get("x-github-mcp-mode") };
}

async function call(name, args) {
  const { result } = await rpc("tools/call", { name, arguments: args });
  assert.equal(result.isError, false, `${name}: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

test("initialize + tools/list", { skip: !(url && token) && "MCP_URL / MCP_TOKEN not set" }, async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.serverInfo.name.startsWith("github-mcp"));
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes("gh_status"));
  // proxies may drop the x-github-mcp-mode header, so decide by serverInfo.name
  const ready = !init.result.serverInfo.name.includes("unconfigured");
  if (ready) assert.ok(names.length > 30, `expected full tool set, got ${names.length}`);
  else assert.deepEqual(names, ["gh_status"]);
});

test("gh_status", { skip: !(url && token) && "MCP_URL / MCP_TOKEN not set" }, async () => {
  const s = await call("gh_status", {});
  assert.equal(typeof s.configured, "boolean");
});

test("unauthenticated → 401 pointing to Access OAuth discovery", { skip: !url && "MCP_URL not set" }, async () => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

test("read tools against a repo", { skip: !(url && token && smokeRepo) && "MCP_URL / MCP_TOKEN / GITHUB_MCP_SMOKE_REPO not set" }, async () => {
  const repo = await call("gh_repo_get", { repo: smokeRepo });
  assert.equal(repo.full_name, smokeRepo);
  const tree = await call("gh_tree", { repo: smokeRepo, max_entries: 20 });
  assert.ok(tree.entries.length > 0);
  const first = tree.entries.find((e) => e.type === "blob");
  const file = await call("gh_file_get", { repo: smokeRepo, path: first.path, max_chars: 500 });
  assert.equal(file.type, "file");
  const issues = await call("gh_issues_list", { repo: smokeRepo, state: "all", per_page: 3 });
  assert.ok(Array.isArray(issues.items));
  const prs = await call("gh_prs_list", { repo: smokeRepo, state: "all", per_page: 3 });
  assert.ok(Array.isArray(prs.items));
  const branches = await call("gh_branches_list", { repo: smokeRepo, per_page: 3 });
  assert.ok(branches.items.length > 0);
  const commits = await call("gh_commits_list", { repo: smokeRepo, per_page: 2 });
  assert.ok(commits.items[0].sha);
  const api = await call("gh_api", { path: `/repos/${smokeRepo}`, query: {} });
  assert.equal(api.status, 200);
  const runs = await call("gh_actions_runs_list", { repo: smokeRepo, per_page: 2 });
  assert.equal(typeof runs.total_count, "number");
});
