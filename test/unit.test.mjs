// Unit tests with the GitHub API replaced by a fetch mock (no network).
//   node --experimental-strip-types --test test/unit.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { TOOLS, callTool } from "../src/tools.ts";
import { createClient } from "../src/github.ts";

const TEAM = "https://team.cloudflareaccess.example";
const AUD = "aud-github-mcp";
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, GITHUB_TOKEN: "ghp_test", DEFAULT_OWNER: "octo-org", GITHUB_API: "https://api.github.com" };
const MCP = "https://mcp-github.example/mcp";

// An Access signing key generated for the tests, and JWTs shaped like the ones Access attaches
const keyPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const JWKS = { keys: [{ ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1", alg: "RS256" }] };
const b64url = (buf) => Buffer.from(buf).toString("base64url");
async function accessJwt(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const body = b64url(JSON.stringify({ aud: [AUD], iss: TEAM, exp: now + 600, iat: now, email: "user@example.com", ...overrides }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}
const JWT = await accessJwt();
const mcpReq = (init = {}, jwt = JWT) => new Request(MCP, { ...init, headers: { "content-type": "application/json", ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...(init.headers ?? {}) } });

/** fetch mock: routes[`METHOD path`] = (url, init) => Response | object */
let calls = [];
let routes = {};
beforeEach(() => {
  calls = [];
  routes = {};
});
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.pathname === "/cdn-cgi/access/certs") return new Response(JSON.stringify(JWKS), { headers: { "content-type": "application/json" } });
  const method = (init.method ?? "GET").toUpperCase();
  const key = `${method} ${url.pathname}`;
  calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const r = routes[key];
  if (!r) return new Response(JSON.stringify({ message: `mock: no route for ${key}` }), { status: 404, headers: { "content-type": "application/json" } });
  const out = typeof r === "function" ? r(url, init) : r;
  if (out instanceof Response) return out;
  return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
};

const ctx = () => ({ gh: createClient(env), env });
const rpc = (method, params, e = env) => worker.fetch(mcpReq({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), e).then((r) => r.json());

test("routing: only /mcp with a valid Access JWT reaches MCP; health → 200, GET on mcp → 405", async () => {
  const post = (jwt, e = env) => worker.fetch(mcpReq({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }, jwt), e);
  assert.equal((await post(null)).status, 403);
  assert.equal((await post("not.a.jwt")).status, 403);
  assert.equal((await post(await accessJwt({ aud: ["other-app"] }))).status, 403);
  assert.equal((await post(await accessJwt({ iss: "https://evil.cloudflareaccess.com" }))).status, 403);
  assert.equal((await post(await accessJwt({ exp: Math.floor(Date.now() / 1000) - 3600 }))).status, 403);
  assert.equal((await post(JWT.slice(0, -4) + "AAAA")).status, 403);
  assert.equal((await post(JWT, { ...env, ACCESS_AUD: undefined })).status, 500);
  assert.equal((await post(JWT)).status, 200);
  assert.equal((await worker.fetch(new Request("https://x/mcp-0123456789abcdef0123456789abcdef", { method: "POST", body: "{}" }), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://x/health"), env)).status, 200);
  assert.equal((await worker.fetch(mcpReq(), env)).status, 405);
});

test("initialize negotiates protocol, tools/list is full when configured and gh_status-only when not", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  const old = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(old.result.protocolVersion, "2025-06-18");
  const full = await rpc("tools/list", {});
  assert.equal(full.result.tools.length, TOOLS.length);
  for (const t of full.result.tools) assert.equal(t.inputSchema.type, "object", t.name);
  const unconf = await rpc("tools/list", {}, { ...env, GITHUB_TOKEN: undefined });
  assert.deepEqual(unconf.result.tools.map((t) => t.name), ["gh_status"]);
  const denied = await rpc("tools/call", { name: "gh_repo_get", arguments: { repo: "octo-repo" } }, { ...env, GITHUB_TOKEN: undefined });
  assert.equal(denied.error.code, -32602);
});

test("notifications get 202 and batches are answered as arrays", async () => {
  const res = await worker.fetch(mcpReq({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), env);
  assert.equal(res.status, 202);
  const batch = await worker.fetch(mcpReq({ method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "nope" }]) }), env).then((r) => r.json());
  assert.equal(batch.length, 2);
  assert.equal(batch[1].error.code, -32601);
});

test("gh_file_get decodes base64 text, lists dirs, flags binaries, sends auth headers", async () => {
  routes["GET /repos/octo-org/octo-repo/contents/README.md"] = { type: "file", path: "README.md", sha: "abc", size: 12, encoding: "base64", content: Buffer.from("# héllo ✓\n").toString("base64") };
  routes["GET /repos/octo-org/octo-repo/contents/docs"] = [{ name: "a.md", path: "docs/a.md", type: "file", size: 1, sha: "1" }];
  routes["GET /repos/octo-org/octo-repo/contents/x.png"] = { type: "file", path: "x.png", sha: "p", size: 3, encoding: "base64", content: btoa("\u0000\u0001\u0002"), download_url: "https://raw/x.png" };
  const f = JSON.parse((await callTool("gh_file_get", { repo: "octo-repo", path: "README.md", ref: "main" }, ctx())).content[0].text);
  assert.equal(f.content, "# héllo ✓\n");
  assert.equal(calls[0].query.ref, "main");
  assert.equal(calls[0].headers.authorization, "Bearer ghp_test");
  assert.equal(calls[0].headers["x-github-api-version"], "2022-11-28");
  const d = JSON.parse((await callTool("gh_file_get", { repo: "octo-org/octo-repo", path: "/docs" }, ctx())).content[0].text);
  assert.equal(d.type, "dir");
  assert.equal(d.entries[0].path, "docs/a.md");
  const b = JSON.parse((await callTool("gh_file_get", { repo: "octo-repo", path: "x.png" }, ctx())).content[0].text);
  assert.equal(b.binary, true);
});

test("gh_push_files: blobs → tree → commit → ref (existing branch) and creates branch when missing", async () => {
  routes["GET /repos/octo-org/octo-repo/git/ref/heads/feat"] = { object: { sha: "base0000" } };
  routes["GET /repos/octo-org/octo-repo/git/commits/base0000"] = { tree: { sha: "tree0000" } };
  routes["POST /repos/octo-org/octo-repo/git/blobs"] = { sha: "blob1" };
  routes["POST /repos/octo-org/octo-repo/git/trees"] = { sha: "tree1" };
  routes["POST /repos/octo-org/octo-repo/git/commits"] = { sha: "commit1", html_url: "https://gh/commit1" };
  routes["PATCH /repos/octo-org/octo-repo/git/refs/heads/feat"] = { object: { sha: "commit1" } };
  const r = JSON.parse((await callTool("gh_push_files", { repo: "octo-repo", branch: "feat", message: "m", files: [{ path: "a.txt", content: "hi" }], deletes: ["old.txt"] }, ctx())).content[0].text);
  assert.equal(r.commit.sha, "commit1");
  assert.equal(r.branch_created, false);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "GET /repos/octo-org/octo-repo/git/ref/heads/feat",
    "GET /repos/octo-org/octo-repo/git/commits/base0000",
    "POST /repos/octo-org/octo-repo/git/blobs",
    "POST /repos/octo-org/octo-repo/git/trees",
    "POST /repos/octo-org/octo-repo/git/commits",
    "PATCH /repos/octo-org/octo-repo/git/refs/heads/feat",
  ]);
  const tree = calls[3].body;
  assert.equal(tree.base_tree, "tree0000");
  assert.deepEqual(tree.tree, [{ path: "a.txt", mode: "100644", type: "blob", sha: "blob1" }, { path: "old.txt", mode: "100644", type: "blob", sha: null }]);
  assert.deepEqual(calls[4].body.parents, ["base0000"]);

  // missing branch → create from default
  calls = [];
  delete routes["GET /repos/octo-org/octo-repo/git/ref/heads/feat"];
  routes["GET /repos/octo-org/octo-repo"] = { default_branch: "main" };
  routes["GET /repos/octo-org/octo-repo/commits/main"] = new Response("mainsha0mainsha0mainsha0mainsha0mainsha0", { status: 200, headers: { "content-type": "application/vnd.github.sha" } });
  routes["GET /repos/octo-org/octo-repo/git/commits/mainsha0mainsha0mainsha0mainsha0mainsha0"] = { tree: { sha: "tree0000" } };
  routes["POST /repos/octo-org/octo-repo/git/refs"] = { ref: "refs/heads/feat" };
  const r2 = JSON.parse((await callTool("gh_push_files", { repo: "octo-repo", branch: "feat", message: "m", files: [{ path: "a.txt", content: "hi" }], create_branch_from: "default" }, ctx())).content[0].text);
  assert.equal(r2.branch_created, true);
  assert.ok(calls.some((c) => c.method === "POST" && c.path.endsWith("/git/refs")));
  // missing branch without create_branch_from → argument error
  const bad = await callTool("gh_push_files", { repo: "octo-repo", branch: "nope", message: "m", files: [{ path: "a", content: "b" }] }, ctx());
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /create_branch_from/);
});

test("gh_file_put looks up sha for update and skips it for create", async () => {
  routes["GET /repos/octo-org/octo-repo/contents/a.md"] = { type: "file", sha: "old" };
  routes["PUT /repos/octo-org/octo-repo/contents/a.md"] = { commit: { sha: "c" }, content: { sha: "new" } };
  const upd = JSON.parse((await callTool("gh_file_put", { repo: "octo-repo", path: "a.md", content: "x", message: "m", branch: "b" }, ctx())).content[0].text);
  assert.equal(upd.action, "updated");
  assert.equal(calls[1].body.sha, "old");
  assert.equal(calls[1].body.content, btoa("x"));
  calls = [];
  routes["PUT /repos/octo-org/octo-repo/contents/new.md"] = { commit: { sha: "c" }, content: { sha: "n" } };
  const cre = JSON.parse((await callTool("gh_file_put", { repo: "octo-repo", path: "new.md", content: "y", message: "m" }, ctx())).content[0].text);
  assert.equal(cre.action, "created");
  assert.equal(calls[1].body.sha, undefined);
});

test("gh_issues_list drops PRs unless include_prs; paging + Link header → next_page", async () => {
  const items = [
    { number: 1, title: "issue", state: "open", user: { login: "u" }, labels: [{ name: "bug" }] },
    { number: 2, title: "pr", state: "open", user: { login: "u" }, pull_request: { url: "x" } },
  ];
  routes["GET /repos/octo-org/octo-repo/issues"] = () => new Response(JSON.stringify(items), { headers: { "content-type": "application/json", link: '<https://api.github.com/repos/octo-org/octo-repo/issues?page=3>; rel="next"' } });
  const r = JSON.parse((await callTool("gh_issues_list", { repo: "octo-repo", per_page: 500, page: 2 }, ctx())).content[0].text);
  assert.deepEqual(r.items.map((i) => i.number), [1]);
  assert.deepEqual(r.items[0].labels, ["bug"]);
  assert.equal(r.next_page, 3);
  assert.equal(calls[0].query.per_page, "100");
  assert.equal(calls[0].query.page, "2");
  const withPrs = JSON.parse((await callTool("gh_issues_list", { repo: "octo-repo", include_prs: true }, ctx())).content[0].text);
  assert.equal(withPrs.items.length, 2);
});

test("gh_actions_job_logs follows redirect without auth, greps and tails", async () => {
  routes["GET /repos/octo-org/octo-repo/actions/jobs/7/logs"] = () => new Response(null, { status: 302, headers: { location: "https://blob.example/log.txt" } });
  routes["GET /log.txt"] = () => new Response("line1\nERROR boom\nline3\nline4\n", { status: 200 });
  const r = JSON.parse((await callTool("gh_actions_job_logs", { repo: "octo-repo", job_id: 7, grep: "error", context_lines: 1 }, ctx())).content[0].text);
  assert.equal(r.log, "line1\nERROR boom\nline3");
  assert.equal(r.matched_lines, 3);
  assert.equal(calls[1].headers.authorization, undefined);
});

test("errors: GitHub 404 → isError with hint, missing args → Invalid arguments, unknown tool", async () => {
  const nf = await callTool("gh_repo_get", { repo: "missing" }, ctx());
  assert.equal(nf.isError, true);
  assert.match(nf.content[0].text, /404 .*not found/);
  const bad = await callTool("gh_issue_get", { repo: "octo-repo" }, ctx());
  assert.match(bad.content[0].text, /number is required/);
  const noOwner = await callTool("gh_repo_get", { repo: "octo-repo" }, { gh: createClient({ ...env, DEFAULT_OWNER: "" }), env: { ...env, DEFAULT_OWNER: "" } });
  assert.match(noOwner.content[0].text, /owner is required/);
  const unk = await callTool("gh_nope", {}, ctx());
  assert.equal(unk.isError, true);
});

test("gh_api returns status/headers/body and passes query + accept", async () => {
  routes["GET /repos/octo-org/octo-repo/topics"] = () => new Response(JSON.stringify({ names: ["a"] }), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" } });
  const r = JSON.parse((await callTool("gh_api", { path: "/repos/octo-org/octo-repo/topics", query: { per_page: 5 }, accept: "application/vnd.github.mercy-preview+json" }, ctx())).content[0].text);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { names: ["a"] });
  assert.equal(r.headers["x-ratelimit-remaining"], "4999");
  assert.equal(calls[0].query.per_page, "5");
  assert.equal(calls[0].headers.accept, "application/vnd.github.mercy-preview+json");
});

test("gh_checks falls back to Actions workflow runs when check runs are forbidden (fine-grained PAT)", async () => {
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  routes["GET /repos/octo-org/octo-repo/commits/main/status"] = { sha, state: "success", statuses: [] };
  routes["GET /repos/octo-org/octo-repo/commits/main/check-runs"] = () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403, headers: { "content-type": "application/json" } });
  routes["GET /repos/octo-org/octo-repo/actions/runs"] = { total_count: 1, workflow_runs: [{ id: 7, name: "CI", status: "completed", conclusion: "failure", head_sha: sha }] };
  const r = JSON.parse((await callTool("gh_checks", { repo: "octo-repo", ref: "main" }, ctx())).content[0].text);
  assert.match(r.check_runs_unavailable, /fine-grained/);
  assert.equal(r.workflow_runs[0].conclusion, "failure");
  assert.equal(calls.at(-1).query.head_sha, sha);
});

test("gh_api refuses full URLs outside api.github.com (the token is never sent elsewhere)", async () => {
  const r = await callTool("gh_api", { path: "https://evil.example/steal" }, ctx());
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Refusing to send the token/);
  assert.equal(calls.length, 0);
  routes["GET /rate_limit"] = { rate: { remaining: 1 } };
  const ok = JSON.parse((await callTool("gh_api", { path: "https://api.github.com/rate_limit" }, ctx())).content[0].text);
  assert.equal(ok.status, 200);
});

test("gh_repos_list falls back from org to user, gh_search maps code results", async () => {
  routes["GET /users/someone/repos"] = [{ full_name: "someone/r", private: false }];
  const r = JSON.parse((await callTool("gh_repos_list", { owner: "someone" }, ctx())).content[0].text);
  assert.equal(r.items[0].full_name, "someone/r");
  assert.deepEqual(calls.map((c) => c.path), ["/orgs/someone/repos", "/users/someone/repos"]);
  routes["GET /search/code"] = { total_count: 1, items: [{ path: "a/b.ts", sha: "0123456789abcdef", repository: { full_name: "octo-org/octo-repo" }, html_url: "u" }] };
  const s = JSON.parse((await callTool("gh_search", { type: "code", q: "repo:octo-org/octo-repo foo" }, ctx())).content[0].text);
  assert.deepEqual(s.items[0], { repo: "octo-org/octo-repo", path: "a/b.ts", sha: "0123456789ab", html_url: "u" });
});
