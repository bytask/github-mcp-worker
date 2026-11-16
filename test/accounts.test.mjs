// Tests for per-account endpoints (/<account>/mcp). GitHub and Access are replaced with a fetch mock (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const TEAM = "https://team.cloudflareaccess.example";
const AUD = "aud-github-mcp";
const base = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, GITHUB_TOKEN: "ghp_default", DEFAULT_OWNER: "octo-user", GITHUB_API: "https://api.github.com" };
const multi = { ...base, ACCOUNTS: { "work": { default_owner: "octo-org" }, "no-token": {} }, GITHUB_TOKEN_WORK: "ghp_work" };

const keyPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const JWKS = { keys: [{ ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1", alg: "RS256" }] };
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const signed = `${b64url(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64url(JSON.stringify({ aud: [AUD], iss: TEAM, exp: now + 600, iat: now }))}`;
const JWT = `${signed}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(signed)))}`;

let calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.pathname === "/cdn-cgi/access/certs") return new Response(JSON.stringify(JWKS), { headers: { "content-type": "application/json" } });
  calls.push({ path: url.pathname, authorization: init.headers?.authorization });
  return new Response(JSON.stringify({ full_name: url.pathname.replace("/repos/", ""), default_branch: "main" }), { headers: { "content-type": "application/json" } });
};

const at = (path, method, params, env = multi, jwt = JWT) =>
  worker.fetch(new Request(`https://mcp-github.example${path}`, { method: "POST", headers: { "content-type": "application/json", ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env);
const repoGet = (path, repo, env) => at(path, "tools/call", { name: "gh_repo_get", arguments: { repo } }, env).then((r) => r.json());

test("/<account>/mcp uses that account's token and default owner; /mcp keeps the default ones", async () => {
  calls = [];
  const r = await repoGet("/work/mcp", "app");
  assert.notEqual(r.result.isError, true);
  assert.deepEqual(calls, [{ path: "/repos/octo-org/app", authorization: "Bearer ghp_work" }]);
  calls = [];
  await repoGet("/mcp", "site");
  assert.deepEqual(calls, [{ path: "/repos/octo-user/site", authorization: "Bearer ghp_default" }]);
  const init = await at("/work/mcp/", "initialize", {}).then((x) => x.json());
  assert.equal(init.result.serverInfo.name, "github-mcp (work)");
  assert.match(init.result.instructions, /GitHub account 'work'/);
  assert.match(init.result.instructions, /Default owner is 'octo-org'/);
  const def = await at("/mcp", "initialize", {}).then((x) => x.json());
  assert.equal(def.result.serverInfo.name, "github-mcp");
});

test("an account without its secret is unconfigured (gh_status only) and never borrows GITHUB_TOKEN", async () => {
  calls = [];
  const list = await at("/no-token/mcp", "tools/list", {}).then((x) => x.json());
  assert.deepEqual(list.result.tools.map((t) => t.name), ["gh_status"]);
  const denied = await repoGet("/no-token/mcp", "site");
  assert.equal(denied.error.code, -32602);
  assert.equal(calls.length, 0);
  const init = await at("/no-token/mcp", "initialize", {}).then((x) => x.json());
  assert.equal(init.result.serverInfo.name, "github-mcp (no-token) (unconfigured)");
  assert.match(init.result.instructions, /GITHUB_TOKEN_NO_TOKEN/);
});

test("unknown accounts and odd keys are 404, Access still guards account endpoints, ACCOUNTS may be a JSON string", async () => {
  for (const p of ["/nope/mcp", "/WORK/mcp", "/__proto__/mcp", "/constructor/mcp", "/work/x/mcp", "/work"]) assert.equal((await at(p, "ping")).status, 404, p);
  assert.equal((await at("/work/mcp", "ping", undefined, base)).status, 404);
  assert.equal((await at("/work/mcp", "ping", undefined, multi, null)).status, 403);
  assert.equal((await at("/work/mcp", "ping", undefined, { ...multi, ACCOUNTS: JSON.stringify(multi.ACCOUNTS) })).status, 200);
  assert.equal((await at("/work/mcp", "ping", undefined, { ...multi, ACCOUNTS: "{broken" })).status, 404);
});
