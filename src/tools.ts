/**
 * MCP tool definitions (gh_*). Shapes GitHub REST / GraphQL into a granularity and output size that LLM clients handle well.
 * Anything not covered falls back to gh_api (generic REST) / gh_graphql.
 */
import { type Env, type Gh, GhError, decodeBase64, encodeBase64Utf8, nextPage } from "./github.ts";

// ---------- schema helpers ----------

type Schema = Record<string, unknown>;
const str = (description: string, extra: Schema = {}): Schema => ({ type: "string", description, ...extra });
const int = (description: string, extra: Schema = {}): Schema => ({ type: "integer", description, ...extra });
const bool = (description: string, extra: Schema = {}): Schema => ({ type: "boolean", description, ...extra });
const obj = (description: string): Schema => ({ type: "object", description, additionalProperties: true });
const arr = (description: string, items: Schema): Schema => ({ type: "array", description, items });
const enumOf = (description: string, values: string[], extra: Schema = {}): Schema => ({ type: "string", description, enum: values, ...extra });
const S = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const OWNER = str("Repository owner (user or org). Defaults to DEFAULT_OWNER when omitted.");
const REPO = str("Repository name. 'owner/name' is also accepted (then owner may be omitted).");
const PER_PAGE = int("Items per page (1-100, default 30).", { minimum: 1, maximum: 100 });
const PAGE = int("Page number (1-based).", { minimum: 1 });
const MAX_CHARS = int("Truncate text output to this many characters (default 60000).", { minimum: 200 });
const REPO_PROPS = { owner: OWNER, repo: REPO };

// ---------- runtime helpers ----------

export interface Ctx {
  gh: Gh;
  env: Env;
}

type Args = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (args: Args, ctx: Ctx) => Promise<unknown>;
}

class ArgError extends Error {}

function repoOf(args: Args, ctx: Ctx): { owner: string; repo: string } {
  let owner = typeof args.owner === "string" && args.owner.trim() ? args.owner.trim() : "";
  let repo = typeof args.repo === "string" ? args.repo.trim() : "";
  if (repo.includes("/")) {
    const [o, r] = repo.split("/", 2);
    if (!owner) owner = o;
    repo = r;
  }
  if (!owner) owner = ctx.env.DEFAULT_OWNER ?? "";
  if (!owner) throw new ArgError("owner is required (no DEFAULT_OWNER configured)");
  if (!repo) throw new ArgError("repo is required");
  return { owner, repo };
}

function need<T = string>(args: Args, key: string): T {
  const v = args[key];
  if (v === undefined || v === null || v === "") throw new ArgError(`${key} is required`);
  return v as T;
}

function opt<T>(args: Args, key: string): T | undefined {
  const v = args[key];
  return v === undefined || v === null || v === "" ? undefined : (v as T);
}

function paging(args: Args): { per_page: number; page: number } {
  const per_page = Math.min(Math.max(Number(args.per_page ?? 30) || 30, 1), 100);
  const page = Math.max(Number(args.page ?? 1) || 1, 1);
  return { per_page, page };
}

function clip(text: string, max: unknown, fallback = 60000): { text: string; truncated: boolean; total_chars: number } {
  const limit = Math.max(Number(max ?? fallback) || fallback, 200);
  if (text.length <= limit) return { text, truncated: false, total_chars: text.length };
  return { text: `${text.slice(0, limit)}\n… [truncated ${text.length - limit} of ${text.length} chars]`, truncated: true, total_chars: text.length };
}

function pick<T extends Record<string, unknown>>(o: T | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!o) return out;
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ---------- slimmers (reduce GitHub's verbose JSON to the essentials) ----------

const login = (u: Any) => (u && typeof u === "object" ? u.login : u) ?? null;
const shortSha = (s: unknown) => (typeof s === "string" ? s.slice(0, 12) : s);

function slimRepo(r: Any) {
  return {
    full_name: r.full_name,
    private: r.private,
    visibility: r.visibility,
    description: r.description,
    default_branch: r.default_branch,
    language: r.language,
    archived: r.archived,
    fork: r.fork,
    open_issues: r.open_issues_count,
    stars: r.stargazers_count,
    pushed_at: r.pushed_at,
    updated_at: r.updated_at,
    html_url: r.html_url,
  };
}

function slimIssue(i: Any, withBody = false) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    state_reason: i.state_reason ?? undefined,
    is_pull_request: Boolean(i.pull_request),
    user: login(i.user),
    assignees: (i.assignees ?? []).map(login),
    labels: (i.labels ?? []).map((l: Any) => (typeof l === "string" ? l : l.name)),
    milestone: i.milestone?.title ?? null,
    comments: i.comments,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    html_url: i.html_url,
    ...(withBody ? { body: i.body ?? "" } : {}),
  };
}

function slimPr(p: Any, withBody = false) {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft,
    merged: p.merged ?? (p.merged_at ? true : undefined),
    merged_at: p.merged_at,
    mergeable: p.mergeable,
    mergeable_state: p.mergeable_state,
    user: login(p.user),
    head: p.head ? { ref: p.head.ref, sha: p.head.sha, repo: p.head.repo?.full_name } : undefined,
    base: p.base ? { ref: p.base.ref, sha: p.base.sha } : undefined,
    labels: (p.labels ?? []).map((l: Any) => l.name),
    assignees: (p.assignees ?? []).map(login),
    requested_reviewers: (p.requested_reviewers ?? []).map(login),
    comments: p.comments,
    review_comments: p.review_comments,
    commits: p.commits,
    additions: p.additions,
    deletions: p.deletions,
    changed_files: p.changed_files,
    created_at: p.created_at,
    updated_at: p.updated_at,
    closed_at: p.closed_at,
    html_url: p.html_url,
    ...(withBody ? { body: p.body ?? "" } : {}),
  };
}

function slimCommit(c: Any) {
  const cc = c.commit ?? {};
  return {
    sha: c.sha,
    message: cc.message,
    author: { name: cc.author?.name, login: login(c.author), date: cc.author?.date },
    committer_date: cc.committer?.date,
    parents: (c.parents ?? []).map((p: Any) => shortSha(p.sha)),
    html_url: c.html_url,
  };
}

function slimFile(f: Any, withPatch: boolean) {
  return {
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    previous_filename: f.previous_filename,
    ...(withPatch ? { patch: f.patch } : {}),
  };
}

function slimComment(c: Any) {
  return { id: c.id, user: login(c.user), body: c.body, created_at: c.created_at, updated_at: c.updated_at, html_url: c.html_url };
}

function slimReviewComment(c: Any) {
  return {
    id: c.id,
    user: login(c.user),
    path: c.path,
    line: c.line ?? c.original_line,
    side: c.side,
    start_line: c.start_line ?? undefined,
    in_reply_to_id: c.in_reply_to_id,
    pull_request_review_id: c.pull_request_review_id,
    body: c.body,
    created_at: c.created_at,
    html_url: c.html_url,
  };
}

function slimReview(r: Any) {
  return { id: r.id, user: login(r.user), state: r.state, body: r.body, commit_id: shortSha(r.commit_id), submitted_at: r.submitted_at, html_url: r.html_url };
}

function slimRun(r: Any) {
  return {
    id: r.id,
    name: r.name,
    workflow_id: r.workflow_id,
    run_number: r.run_number,
    run_attempt: r.run_attempt,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    head_branch: r.head_branch,
    head_sha: shortSha(r.head_sha),
    actor: login(r.actor ?? r.triggering_actor),
    created_at: r.created_at,
    updated_at: r.updated_at,
    html_url: r.html_url,
  };
}

function slimJob(j: Any) {
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    started_at: j.started_at,
    completed_at: j.completed_at,
    html_url: j.html_url,
    steps: (j.steps ?? []).map((s: Any) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion })),
  };
}

function slimCheckRun(c: Any) {
  return {
    id: c.id,
    name: c.name,
    app: c.app?.slug,
    status: c.status,
    conclusion: c.conclusion,
    started_at: c.started_at,
    completed_at: c.completed_at,
    details_url: c.details_url,
    html_url: c.html_url,
    output_title: c.output?.title ?? undefined,
    output_summary: c.output?.summary ? String(c.output.summary).slice(0, 2000) : undefined,
  };
}

function slimRelease(r: Any) {
  return {
    id: r.id,
    tag_name: r.tag_name,
    name: r.name,
    draft: r.draft,
    prerelease: r.prerelease,
    author: login(r.author),
    created_at: r.created_at,
    published_at: r.published_at,
    html_url: r.html_url,
    assets: (r.assets ?? []).map((a: Any) => ({ name: a.name, size: a.size, download_count: a.download_count, url: a.browser_download_url })),
  };
}

// ---------- git data helpers ----------

async function defaultBranch(gh: Gh, owner: string, repo: string): Promise<string> {
  const r = await gh.get<Any>(`/repos/${owner}/${repo}`);
  return r.data.default_branch as string;
}

async function resolveSha(gh: Gh, owner: string, repo: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
  const r = await gh.get<Any>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, undefined, "application/vnd.github.sha");
  return String(r.data).trim();
}

async function getRefSha(gh: Gh, owner: string, repo: string, branch: string): Promise<string | null> {
  try {
    const r = await gh.get<Any>(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return r.data.object.sha as string;
  } catch (e) {
    if (e instanceof GhError && e.status === 404) return null;
    throw e;
  }
}

/**
 * CI state of a ref (check runs + commit statuses).
 * Fine-grained PATs cannot be granted the Checks permission, so check-runs returns 403; in that case fall back to the Actions workflow runs for the same sha.
 */
async function commitChecks(gh: Gh, owner: string, repo: string, ref: string, filter: { check_name?: string; status?: string } = {}) {
  const st = await gh.get<Any>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status`);
  const out: Record<string, unknown> = {
    sha: shortSha(st.data.sha),
    commit_status: { state: st.data.state, statuses: (st.data.statuses as Any[]).map((s) => ({ context: s.context, state: s.state, description: s.description, target_url: s.target_url })) },
  };
  try {
    const cr = await gh.get<Any>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`, { ...filter, per_page: 100 });
    out.total_check_runs = cr.data.total_count;
    out.check_runs = (cr.data.check_runs as Any[]).map(slimCheckRun);
  } catch (e) {
    if (!(e instanceof GhError && e.status === 403)) throw e;
    const runs = await gh.get<Any>(`/repos/${owner}/${repo}/actions/runs`, { head_sha: st.data.sha, per_page: 100 });
    out.check_runs_unavailable = "the token cannot read check runs (fine-grained PAT); showing GitHub Actions workflow runs for this sha instead";
    out.workflow_runs = (runs.data.workflow_runs as Any[]).map(slimRun);
  }
  return out;
}

async function fetchJobLogs(gh: Gh, path: string): Promise<string> {
  const res = await gh.raw("GET", path);
  if (res.status === 302 || res.status === 301 || res.status === 307) {
    const loc = res.headers.get("location");
    if (!loc) throw new GhError(res.status, "logs redirect without location");
    const r2 = await fetch(loc, { headers: { "user-agent": "github-mcp/1.0" } });
    if (!r2.ok) throw new GhError(r2.status, `log download failed: ${r2.status}`);
    return r2.text();
  }
  const text = await res.text();
  if (!res.ok) throw new GhError(res.status, `logs: ${res.status} ${text.slice(0, 300)}`);
  return text;
}

function tailAndGrep(text: string, args: Args): { lines: string; matched?: number; total_lines: number } {
  let lines = text.split(/\r?\n/);
  const total = lines.length;
  let matched: number | undefined;
  const grep = opt<string>(args, "grep");
  if (grep) {
    let re: RegExp;
    try {
      re = new RegExp(grep, "i");
    } catch {
      re = new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const ctx = Math.max(Number(args.context_lines ?? 0) || 0, 0);
    const keep = new Set<number>();
    lines.forEach((l, i) => {
      if (re.test(l)) for (let k = i - ctx; k <= i + ctx; k++) keep.add(k);
    });
    matched = keep.size;
    lines = lines.filter((_, i) => keep.has(i));
  }
  const tail = Math.max(Number(args.tail_lines ?? 200) || 200, 1);
  if (lines.length > tail) lines = lines.slice(-tail);
  return { lines: lines.join("\n"), matched, total_lines: total };
}

// ---------- tools ----------

export const TOOLS: Tool[] = [
  // ----- meta -----
  {
    name: "gh_status",
    description: "Server status: whether GITHUB_TOKEN is configured, the authenticated user, token scopes and current rate limit. Call this first if other tools fail.",
    inputSchema: S({}),
    handler: async (_a, { gh, env }) => {
      if (!env.GITHUB_TOKEN) {
        return {
          configured: false,
          missing: ["GITHUB_TOKEN"],
          next_steps: [
            "Create a GitHub personal access token (fine-grained: Contents/Issues/PRs/Actions/Metadata read+write on the repos you want; or classic with repo, workflow, read:org).",
            "npx wrangler secret put GITHUB_TOKEN  (in the worker directory)",
            "Reconnect this MCP server; the gh_* tools then appear.",
          ],
        };
      }
      const out: Record<string, unknown> = { configured: true, default_owner: env.DEFAULT_OWNER || null };
      try {
        const me = await gh.get<Any>("/user");
        out.user = { login: me.data.login, name: me.data.name, type: me.data.type };
        out.token_scopes = me.headers.get("x-oauth-scopes") ?? "(fine-grained PAT or app token: scopes not exposed)";
      } catch (e) {
        out.user_error = (e as Error).message;
      }
      try {
        const rl = await gh.get<Any>("/rate_limit");
        out.rate_limit = pick(rl.data.resources?.core, ["limit", "remaining", "reset"]);
        out.search_rate_limit = pick(rl.data.resources?.search, ["limit", "remaining", "reset"]);
      } catch (e) {
        out.rate_limit_error = (e as Error).message;
      }
      return out;
    },
  },
  {
    name: "gh_api",
    description:
      "Generic GitHub REST call for anything not covered by other tools. path is relative to https://api.github.com (e.g. /repos/{owner}/{repo}/topics). Returns status, selected headers and the JSON/text body (truncated).",
    inputSchema: S(
      {
        method: enumOf("HTTP method", ["GET", "POST", "PATCH", "PUT", "DELETE"], { default: "GET" }),
        path: str("API path, e.g. /repos/octo-org/octo-repo/topics (a full https://api.github.com/... URL is also accepted)"),
        query: obj("Query string parameters"),
        body: obj("JSON request body (object)"),
        accept: str("Accept header override, e.g. application/vnd.github.raw+json or application/vnd.github.diff"),
        max_chars: MAX_CHARS,
      },
      ["path"],
    ),
    handler: async (a, { gh }) => {
      const method = String(a.method ?? "GET").toUpperCase();
      const res = await gh.raw(method, need(a, "path"), {
        query: opt<Record<string, unknown>>(a, "query"),
        body: a.body,
        accept: opt<string>(a, "accept"),
      });
      const text = await res.text();
      let data: unknown = text;
      if ((res.headers.get("content-type") ?? "").includes("json") && text) {
        try {
          data = JSON.parse(text);
        } catch {
          /* text */
        }
      }
      const headers: Record<string, string> = {};
      for (const h of ["x-ratelimit-remaining", "link", "location", "content-type", "etag"]) {
        const v = res.headers.get(h);
        if (v) headers[h] = v;
      }
      if (typeof data === "string") {
        const c = clip(data, a.max_chars);
        return { status: res.status, headers, body: c.text, truncated: c.truncated };
      }
      const c = clip(JSON.stringify(data), a.max_chars);
      return { status: res.status, headers, body: c.truncated ? c.text : data, truncated: c.truncated };
    },
  },
  {
    name: "gh_graphql",
    description: "Run a GitHub GraphQL query/mutation (https://api.github.com/graphql). Use for things REST lacks: projects v2, discussions, PR draft toggle, review thread resolution, etc.",
    inputSchema: S({ query: str("GraphQL document"), variables: obj("Variables object"), max_chars: MAX_CHARS }, ["query"]),
    handler: async (a, { gh }) => {
      const data = await gh.graphql(need(a, "query"), opt<Record<string, unknown>>(a, "variables"));
      const c = clip(JSON.stringify(data), a.max_chars);
      return c.truncated ? { data: c.text, truncated: true } : { data };
    },
  },
  {
    name: "gh_search",
    description:
      "GitHub search. type=code (needs 'repo:'/'org:' qualifier for private repos), issues (issues and PRs; use 'is:pr'/'is:issue'), repositories, commits, users. q uses GitHub search syntax.",
    inputSchema: S(
      {
        type: enumOf("What to search", ["code", "issues", "repositories", "commits", "users"]),
        q: str("Search query, e.g. 'org:octo-org is:pr is:open review-requested:@me' or 'repo:octo-org/octo-repo path:src wrangler'"),
        sort: str("Sort field (type-specific: e.g. updated, created, comments, stars, indexed)"),
        order: enumOf("Sort order", ["asc", "desc"]),
        per_page: PER_PAGE,
        page: PAGE,
      },
      ["type", "q"],
    ),
    handler: async (a, { gh }) => {
      const type = need(a, "type");
      const r = await gh.get<Any>(`/search/${type}`, { q: need(a, "q"), sort: opt(a, "sort"), order: opt(a, "order"), ...paging(a) });
      const items = (r.data.items ?? []) as Any[];
      const mapped = items.map((it) => {
        switch (type) {
          case "code":
            return { repo: it.repository?.full_name, path: it.path, sha: shortSha(it.sha), html_url: it.html_url };
          case "issues":
            return { repo: it.repository_url?.replace(/^.*\/repos\//, ""), ...slimIssue(it) };
          case "repositories":
            return slimRepo(it);
          case "commits":
            return { repo: it.repository?.full_name, ...slimCommit(it) };
          case "users":
            return { login: it.login, type: it.type, html_url: it.html_url };
          default:
            return it;
        }
      });
      return { total_count: r.data.total_count, incomplete_results: r.data.incomplete_results, items: mapped, next_page: nextPage(r.headers) };
    },
  },

  // ----- repositories -----
  {
    name: "gh_repos_list",
    description: "List repositories. With owner: that org's (or user's) repos. Without owner: repos the token can access (owner/collaborator/org member), newest push first.",
    inputSchema: S({
      owner: str("Org or user login. Omit for 'all repos accessible to the token'."),
      type: enumOf("Filter (org: all/public/private/forks/sources/member; user: all/owner/member)", ["all", "public", "private", "forks", "sources", "member", "owner"]),
      sort: enumOf("Sort", ["pushed", "updated", "created", "full_name"], { default: "pushed" }),
      direction: enumOf("Direction", ["asc", "desc"]),
      per_page: PER_PAGE,
      page: PAGE,
    }),
    handler: async (a, { gh }) => {
      const owner = opt<string>(a, "owner");
      const q = { type: opt(a, "type"), sort: a.sort ?? "pushed", direction: opt(a, "direction"), ...paging(a) };
      let r: Any;
      if (!owner) {
        r = await gh.get<Any>("/user/repos", { ...q, affiliation: "owner,collaborator,organization_member", type: undefined });
      } else {
        try {
          r = await gh.get<Any>(`/orgs/${owner}/repos`, q);
        } catch (e) {
          if (!(e instanceof GhError && e.status === 404)) throw e;
          r = await gh.get<Any>(`/users/${owner}/repos`, q);
        }
      }
      return { items: (r.data as Any[]).map(slimRepo), next_page: nextPage(r.headers) };
    },
  },
  {
    name: "gh_repo_get",
    description: "Get repository details (default branch, visibility, topics, permissions, license, counts).",
    inputSchema: S(REPO_PROPS, ["repo"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}`);
      return {
        ...slimRepo(r.data),
        topics: r.data.topics,
        license: r.data.license?.spdx_id ?? null,
        size_kb: r.data.size,
        forks: r.data.forks_count,
        watchers: r.data.subscribers_count,
        has_issues: r.data.has_issues,
        has_wiki: r.data.has_wiki,
        permissions: r.data.permissions,
        created_at: r.data.created_at,
        homepage: r.data.homepage,
        clone_url: r.data.clone_url,
      };
    },
  },
  {
    name: "gh_repo_create",
    description: "Create a repository (private by default). Set org to create under an organization, otherwise under the authenticated user.",
    inputSchema: S(
      {
        name: str("Repository name"),
        org: str("Organization login (omit for personal repo)"),
        description: str("Description"),
        private: bool("Private repo (default true)", { default: true }),
        auto_init: bool("Create an initial commit with README (default false)"),
        gitignore_template: str("e.g. Node, Python"),
        license_template: str("e.g. mit, apache-2.0"),
      },
      ["name"],
    ),
    handler: async (a, { gh }) => {
      const body = {
        name: need(a, "name"),
        description: opt(a, "description"),
        private: a.private === undefined ? true : Boolean(a.private),
        auto_init: opt(a, "auto_init"),
        gitignore_template: opt(a, "gitignore_template"),
        license_template: opt(a, "license_template"),
      };
      const org = opt<string>(a, "org");
      const r = await gh.post<Any>(org ? `/orgs/${org}/repos` : "/user/repos", body);
      return { ...slimRepo(r.data), clone_url: r.data.clone_url, ssh_url: r.data.ssh_url };
    },
  },

  // ----- contents / git -----
  {
    name: "gh_file_get",
    description: "Read a file (decoded UTF-8 text) or list a directory at a path. Handles files >1MB via the raw API. Binary files return metadata + download_url only.",
    inputSchema: S({ ...REPO_PROPS, path: str("Path within the repo ('' or '/' for root)"), ref: str("Branch, tag or commit SHA (default: default branch)"), max_chars: MAX_CHARS }, [
      "repo",
      "path",
    ]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const path = String(a.path ?? "").replace(/^\/+/, "");
      const ref = opt<string>(a, "ref");
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, { ref });
      if (Array.isArray(r.data)) {
        return {
          type: "dir",
          path,
          ref: ref ?? null,
          entries: r.data.map((e: Any) => ({ name: e.name, path: e.path, type: e.type, size: e.size, sha: shortSha(e.sha) })),
        };
      }
      const f = r.data;
      if (f.type !== "file") return { type: f.type, path: f.path, sha: f.sha, size: f.size, target: f.target, submodule_git_url: f.submodule_git_url, download_url: f.download_url };
      let text = "";
      let binary = false;
      if (f.encoding === "base64" && typeof f.content === "string" && f.content) {
        const d = decodeBase64(f.content);
        text = d.text;
        binary = d.binary;
      } else {
        // >1MB: the contents API omits content → fetch raw
        const raw = await ctx.gh.raw("GET", `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
          query: { ref },
          accept: "application/vnd.github.raw+json",
        });
        const buf = new Uint8Array(await raw.arrayBuffer());
        binary = buf.subarray(0, 8000).includes(0);
        text = binary ? "" : new TextDecoder().decode(buf);
      }
      if (binary) return { type: "file", path: f.path, sha: f.sha, size: f.size, binary: true, download_url: f.download_url, html_url: f.html_url };
      const c = clip(text, a.max_chars);
      return { type: "file", path: f.path, sha: f.sha, size: f.size, ref: ref ?? null, html_url: f.html_url, content: c.text, truncated: c.truncated, total_chars: c.total_chars };
    },
  },
  {
    name: "gh_tree",
    description: "List the file tree of a ref (recursive by default). Filter with path_prefix. Use before gh_file_get to find files.",
    inputSchema: S(
      {
        ...REPO_PROPS,
        ref: str("Branch, tag or commit SHA (default: default branch)"),
        path_prefix: str("Only entries whose path starts with this (e.g. 'src/')"),
        recursive: bool("Recurse into subdirectories (default true)", { default: true }),
        max_entries: int("Max entries to return (default 500)", { minimum: 1 }),
      },
      ["repo"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const ref = opt<string>(a, "ref") ?? (await defaultBranch(ctx.gh, owner, repo));
      const recursive = a.recursive === undefined ? true : Boolean(a.recursive);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`, recursive ? { recursive: "1" } : undefined);
      const prefix = opt<string>(a, "path_prefix") ?? "";
      const max = Math.max(Number(a.max_entries ?? 500) || 500, 1);
      const all = (r.data.tree as Any[]).filter((e) => !prefix || String(e.path).startsWith(prefix));
      return {
        ref,
        sha: shortSha(r.data.sha),
        total: all.length,
        truncated: all.length > max || Boolean(r.data.truncated),
        entries: all.slice(0, max).map((e) => ({ path: e.path, type: e.type, size: e.size })),
      };
    },
  },
  {
    name: "gh_file_put",
    description: "Create or update a single file with a commit (Contents API). Fetches the current blob sha automatically when updating. For several files in one commit use gh_push_files.",
    inputSchema: S(
      {
        ...REPO_PROPS,
        path: str("File path"),
        content: str("File content (UTF-8 text, or base64 when encoding=base64)"),
        message: str("Commit message"),
        branch: str("Branch (default: default branch)"),
        sha: str("Current blob sha if known (skips the lookup)"),
        encoding: enumOf("Content encoding", ["utf-8", "base64"], { default: "utf-8" }),
      },
      ["repo", "path", "content", "message"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const path = String(need(a, "path")).replace(/^\/+/, "");
      const enc = path.split("/").map(encodeURIComponent).join("/");
      const branch = opt<string>(a, "branch");
      let sha = opt<string>(a, "sha");
      if (!sha) {
        try {
          const cur = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/contents/${enc}`, { ref: branch });
          if (!Array.isArray(cur.data) && cur.data.sha) sha = cur.data.sha;
        } catch (e) {
          if (!(e instanceof GhError && e.status === 404)) throw e;
        }
      }
      const content = a.encoding === "base64" ? String(need(a, "content")) : encodeBase64Utf8(String(need(a, "content")));
      const r = await ctx.gh.put<Any>(`/repos/${owner}/${repo}/contents/${enc}`, { message: need(a, "message"), content, branch, sha });
      return { action: sha ? "updated" : "created", path, branch: branch ?? null, commit: { sha: r.data.commit?.sha, html_url: r.data.commit?.html_url }, content_sha: r.data.content?.sha };
    },
  },
  {
    name: "gh_file_delete",
    description: "Delete a single file with a commit.",
    inputSchema: S({ ...REPO_PROPS, path: str("File path"), message: str("Commit message"), branch: str("Branch (default: default branch)"), sha: str("Current blob sha if known") }, [
      "repo",
      "path",
      "message",
    ]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const path = String(need(a, "path")).replace(/^\/+/, "");
      const enc = path.split("/").map(encodeURIComponent).join("/");
      const branch = opt<string>(a, "branch");
      let sha = opt<string>(a, "sha");
      if (!sha) {
        const cur = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/contents/${enc}`, { ref: branch });
        if (Array.isArray(cur.data)) throw new ArgError(`${path} is a directory`);
        sha = cur.data.sha;
      }
      const r = await ctx.gh.del<Any>(`/repos/${owner}/${repo}/contents/${enc}`, { message: need(a, "message"), branch, sha });
      return { deleted: path, branch: branch ?? null, commit: { sha: r.data.commit?.sha, html_url: r.data.commit?.html_url } };
    },
  },
  {
    name: "gh_push_files",
    description:
      "Commit several file changes atomically to a branch (Git Data API: blobs → tree → commit → ref). Can create the branch from another ref first. Use for multi-file edits instead of repeated gh_file_put.",
    inputSchema: S(
      {
        ...REPO_PROPS,
        branch: str("Target branch"),
        message: str("Commit message"),
        files: arr("Files to add/update", S({ path: str("File path"), content: str("Content (UTF-8 text unless encoding=base64)"), encoding: enumOf("Encoding", ["utf-8", "base64"]), mode: enumOf("Git file mode", ["100644", "100755", "120000"]) }, ["path", "content"])),
        deletes: arr("File paths to delete", str("path")),
        create_branch_from: str("If the branch does not exist, create it from this branch/tag/sha (default: default branch when set to 'default')"),
      },
      ["repo", "branch", "message"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const gh = ctx.gh;
      const branch = need<string>(a, "branch");
      const files = (opt<Any[]>(a, "files") ?? []) as Any[];
      const deletes = (opt<string[]>(a, "deletes") ?? []) as string[];
      if (files.length === 0 && deletes.length === 0) throw new ArgError("files or deletes is required");
      let baseSha = await getRefSha(gh, owner, repo, branch);
      let created = false;
      if (!baseSha) {
        const from = opt<string>(a, "create_branch_from");
        if (!from) throw new ArgError(`branch '${branch}' does not exist; set create_branch_from to create it`);
        baseSha = await resolveSha(gh, owner, repo, from === "default" ? await defaultBranch(gh, owner, repo) : from);
        created = true;
      }
      const baseCommit = await gh.get<Any>(`/repos/${owner}/${repo}/git/commits/${baseSha}`);
      const tree: Any[] = [];
      for (const f of files) {
        const p = String(f.path).replace(/^\/+/, "");
        const isB64 = f.encoding === "base64";
        const blob = await gh.post<Any>(`/repos/${owner}/${repo}/git/blobs`, isB64 ? { content: f.content, encoding: "base64" } : { content: String(f.content), encoding: "utf-8" });
        tree.push({ path: p, mode: f.mode ?? "100644", type: "blob", sha: blob.data.sha });
      }
      for (const d of deletes) tree.push({ path: String(d).replace(/^\/+/, ""), mode: "100644", type: "blob", sha: null });
      const newTree = await gh.post<Any>(`/repos/${owner}/${repo}/git/trees`, { base_tree: baseCommit.data.tree.sha, tree });
      const commit = await gh.post<Any>(`/repos/${owner}/${repo}/git/commits`, { message: need(a, "message"), tree: newTree.data.sha, parents: [baseSha] });
      if (created) await gh.post(`/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.data.sha });
      else await gh.patch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.data.sha, force: false });
      return { branch, branch_created: created, commit: { sha: commit.data.sha, html_url: commit.data.html_url }, files: files.map((f) => f.path), deleted: deletes };
    },
  },
  {
    name: "gh_branches_list",
    description: "List branches.",
    inputSchema: S({ ...REPO_PROPS, protected: bool("Only protected branches"), per_page: PER_PAGE, page: PAGE }, ["repo"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/branches`, { protected: opt(a, "protected"), ...paging(a) });
      return { items: (r.data as Any[]).map((b) => ({ name: b.name, sha: shortSha(b.commit?.sha), protected: b.protected })), next_page: nextPage(r.headers) };
    },
  },
  {
    name: "gh_branch_create",
    description: "Create a branch from another branch, tag or commit (default: the default branch).",
    inputSchema: S({ ...REPO_PROPS, branch: str("New branch name"), from: str("Source branch/tag/sha (default: default branch)") }, ["repo", "branch"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const from = opt<string>(a, "from") ?? (await defaultBranch(ctx.gh, owner, repo));
      const sha = await resolveSha(ctx.gh, owner, repo, from);
      const r = await ctx.gh.post<Any>(`/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${need(a, "branch")}`, sha });
      return { ref: r.data.ref, sha: r.data.object?.sha, from };
    },
  },
  {
    name: "gh_branch_delete",
    description: "Delete a branch.",
    inputSchema: S({ ...REPO_PROPS, branch: str("Branch name") }, ["repo", "branch"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      await ctx.gh.del(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(need(a, "branch"))}`);
      return { deleted: need(a, "branch") };
    },
  },
  {
    name: "gh_commits_list",
    description: "List commits on a branch (or all), optionally filtered by path, author and date range.",
    inputSchema: S(
      { ...REPO_PROPS, sha: str("Branch name or commit SHA to start from (default: default branch)"), path: str("Only commits touching this path"), author: str("GitHub login or email"), since: str("ISO 8601"), until: str("ISO 8601"), per_page: PER_PAGE, page: PAGE },
      ["repo"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/commits`, { sha: opt(a, "sha"), path: opt(a, "path"), author: opt(a, "author"), since: opt(a, "since"), until: opt(a, "until"), ...paging(a) });
      return { items: (r.data as Any[]).map(slimCommit), next_page: nextPage(r.headers) };
    },
  },
  {
    name: "gh_commit_get",
    description: "Get one commit with stats and changed files (optionally with patches).",
    inputSchema: S({ ...REPO_PROPS, sha: str("Commit SHA or ref"), include_patch: bool("Include per-file patch text (default false)"), max_chars: MAX_CHARS }, ["repo", "sha"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(need(a, "sha"))}`);
      const withPatch = Boolean(a.include_patch);
      const out = { ...slimCommit(r.data), stats: r.data.stats, files: (r.data.files ?? []).map((f: Any) => slimFile(f, withPatch)) };
      const c = clip(JSON.stringify(out), a.max_chars);
      return c.truncated ? { ...out, files: c.text, truncated: true } : out;
    },
  },
  {
    name: "gh_compare",
    description: "Compare two refs (base...head): ahead/behind, commits and changed files.",
    inputSchema: S({ ...REPO_PROPS, base: str("Base ref"), head: str("Head ref (use 'owner:branch' for forks)"), include_patch: bool("Include patches (default false)"), max_chars: MAX_CHARS }, ["repo", "base", "head"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/compare/${encodeURIComponent(need(a, "base"))}...${encodeURIComponent(need(a, "head"))}`);
      const withPatch = Boolean(a.include_patch);
      const out = {
        status: r.data.status,
        ahead_by: r.data.ahead_by,
        behind_by: r.data.behind_by,
        total_commits: r.data.total_commits,
        html_url: r.data.html_url,
        commits: (r.data.commits ?? []).map(slimCommit),
        files: (r.data.files ?? []).map((f: Any) => slimFile(f, withPatch)),
      };
      const c = clip(JSON.stringify(out), a.max_chars);
      return c.truncated ? { ...out, files: c.text, truncated: true } : out;
    },
  },

  // ----- issues -----
  {
    name: "gh_issues_list",
    description: "List issues of a repo (pull requests excluded unless include_prs). Filter by state, labels, assignee, creator, since.",
    inputSchema: S(
      {
        ...REPO_PROPS,
        state: enumOf("State", ["open", "closed", "all"], { default: "open" }),
        labels: str("Comma-separated label names"),
        assignee: str("Login, '*' (any) or 'none'"),
        creator: str("Login"),
        mentioned: str("Login"),
        milestone: str("Milestone number, '*' or 'none'"),
        since: str("ISO 8601: only issues updated after"),
        sort: enumOf("Sort", ["created", "updated", "comments"]),
        direction: enumOf("Direction", ["asc", "desc"]),
        include_prs: bool("Include pull requests in the list (default false)"),
        per_page: PER_PAGE,
        page: PAGE,
      },
      ["repo"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/issues`, {
        state: a.state ?? "open",
        labels: opt(a, "labels"),
        assignee: opt(a, "assignee"),
        creator: opt(a, "creator"),
        mentioned: opt(a, "mentioned"),
        milestone: opt(a, "milestone"),
        since: opt(a, "since"),
        sort: opt(a, "sort"),
        direction: opt(a, "direction"),
        ...paging(a),
      });
      const items = (r.data as Any[]).filter((i) => Boolean(a.include_prs) || !i.pull_request).map((i) => slimIssue(i));
      return { items, next_page: nextPage(r.headers) };
    },
  },
  {
    name: "gh_issue_get",
    description: "Get an issue (or the issue side of a PR) with body, optionally with its comments.",
    inputSchema: S({ ...REPO_PROPS, number: int("Issue number"), include_comments: bool("Also return comments (default false)"), max_chars: MAX_CHARS }, ["repo", "number"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const n = need<number>(a, "number");
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/issues/${n}`);
      const out: Any = slimIssue(r.data, true);
      if (a.include_comments) {
        const c = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/issues/${n}/comments`, { per_page: 100 });
        out.comments_list = (c.data as Any[]).map(slimComment);
      }
      const c = clip(JSON.stringify(out), a.max_chars);
      return c.truncated ? { ...out, body: clip(out.body, Number(a.max_chars ?? 60000) / 2).text, comments_list: undefined, truncated: true } : out;
    },
  },
  {
    name: "gh_issue_create",
    description: "Create an issue.",
    inputSchema: S({ ...REPO_PROPS, title: str("Title"), body: str("Markdown body"), labels: arr("Label names", str("label")), assignees: arr("Logins", str("login")), milestone: int("Milestone number") }, ["repo", "title"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.post<Any>(`/repos/${owner}/${repo}/issues`, { title: need(a, "title"), body: opt(a, "body"), labels: opt(a, "labels"), assignees: opt(a, "assignees"), milestone: opt(a, "milestone") });
      return slimIssue(r.data);
    },
  },
  {
    name: "gh_issue_update",
    description: "Update an issue: title, body, state (open/closed with state_reason), labels (replaces), assignees (replaces), milestone.",
    inputSchema: S(
      {
        ...REPO_PROPS,
        number: int("Issue number"),
        title: str("New title"),
        body: str("New body"),
        state: enumOf("State", ["open", "closed"]),
        state_reason: enumOf("Reason when closing/reopening", ["completed", "not_planned", "reopened"]),
        labels: arr("Label names (replaces all)", str("label")),
        assignees: arr("Logins (replaces all)", str("login")),
        milestone: int("Milestone number (0 to clear)"),
      },
      ["repo", "number"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const body: Any = pick(a, ["title", "body", "state", "state_reason", "labels", "assignees"]);
      if (a.milestone !== undefined) body.milestone = a.milestone === 0 ? null : a.milestone;
      const r = await ctx.gh.patch<Any>(`/repos/${owner}/${repo}/issues/${need(a, "number")}`, body);
      return slimIssue(r.data);
    },
  },
  {
    name: "gh_issue_comment",
    description: "Add a comment to an issue or pull request (conversation tab).",
    inputSchema: S({ ...REPO_PROPS, number: int("Issue or PR number"), body: str("Markdown body") }, ["repo", "number", "body"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.post<Any>(`/repos/${owner}/${repo}/issues/${need(a, "number")}/comments`, { body: need(a, "body") });
      return slimComment(r.data);
    },
  },
  {
    name: "gh_issue_comments_list",
    description: "List comments on an issue or pull request (conversation tab, not code review comments).",
    inputSchema: S({ ...REPO_PROPS, number: int("Issue or PR number"), since: str("ISO 8601"), per_page: PER_PAGE, page: PAGE }, ["repo", "number"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/issues/${need(a, "number")}/comments`, { since: opt(a, "since"), ...paging(a) });
      return { items: (r.data as Any[]).map(slimComment), next_page: nextPage(r.headers) };
    },
  },
  {
    name: "gh_comment_update",
    description: "Edit an issue/PR conversation comment by id (or delete it).",
    inputSchema: S({ ...REPO_PROPS, comment_id: int("Comment id"), body: str("New body"), delete: bool("Delete instead of edit") }, ["repo", "comment_id"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const id = need(a, "comment_id");
      if (a.delete) {
        await ctx.gh.del(`/repos/${owner}/${repo}/issues/comments/${id}`);
        return { deleted: id };
      }
      const r = await ctx.gh.patch<Any>(`/repos/${owner}/${repo}/issues/comments/${id}`, { body: need(a, "body") });
      return slimComment(r.data);
    },
  },
  {
    name: "gh_labels_list",
    description: "List labels of a repo.",
    inputSchema: S({ ...REPO_PROPS, per_page: PER_PAGE, page: PAGE }, ["repo"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/labels`, paging(a));
      return { items: (r.data as Any[]).map((l) => ({ name: l.name, color: l.color, description: l.description })), next_page: nextPage(r.headers) };
    },
  },

  // ----- pull requests -----
  {
    name: "gh_prs_list",
    description: "List pull requests. Filter by state, head ('owner:branch'), base branch.",
    inputSchema: S(
      {
        ...REPO_PROPS,
        state: enumOf("State", ["open", "closed", "all"], { default: "open" }),
        head: str("Filter by head, format 'owner:branch'"),
        base: str("Filter by base branch"),
        sort: enumOf("Sort", ["created", "updated", "popularity", "long-running"]),
        direction: enumOf("Direction", ["asc", "desc"]),
        per_page: PER_PAGE,
        page: PAGE,
      },
      ["repo"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/pulls`, { state: a.state ?? "open", head: opt(a, "head"), base: opt(a, "base"), sort: opt(a, "sort"), direction: opt(a, "direction"), ...paging(a) });
      return { items: (r.data as Any[]).map((p) => slimPr(p)), next_page: nextPage(r.headers) };
    },
  },
  {
    name: "gh_pr_get",
    description: "Get a pull request: body, mergeability, head/base, and optionally changed files, reviews, review comments and check status.",
    inputSchema: S(
      {
        ...REPO_PROPS,
        number: int("PR number"),
        include_files: bool("Changed files summary (default true)", { default: true }),
        include_reviews: bool("Reviews + review threads (default false)"),
        include_comments: bool("Conversation comments (default false)"),
        include_checks: bool("Check runs / commit status on the head sha (default false)"),
        max_chars: MAX_CHARS,
      },
      ["repo", "number"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const n = need<number>(a, "number");
      const gh = ctx.gh;
      const r = await gh.get<Any>(`/repos/${owner}/${repo}/pulls/${n}`);
      const out: Any = slimPr(r.data, true);
      out.merge_commit_sha = r.data.merge_commit_sha;
      out.rebaseable = r.data.rebaseable;
      out.maintainer_can_modify = r.data.maintainer_can_modify;
      out.merged_by = login(r.data.merged_by);
      if (a.include_files === undefined || a.include_files) {
        const f = await gh.get<Any>(`/repos/${owner}/${repo}/pulls/${n}/files`, { per_page: 100 });
        out.files = (f.data as Any[]).map((x) => slimFile(x, false));
        out.files_next_page = nextPage(f.headers);
      }
      if (a.include_reviews) {
        const rv = await gh.get<Any>(`/repos/${owner}/${repo}/pulls/${n}/reviews`, { per_page: 100 });
        out.reviews = (rv.data as Any[]).map(slimReview);
        const rc = await gh.get<Any>(`/repos/${owner}/${repo}/pulls/${n}/comments`, { per_page: 100 });
        out.review_comments_list = (rc.data as Any[]).map(slimReviewComment);
      }
      if (a.include_comments) {
        const c = await gh.get<Any>(`/repos/${owner}/${repo}/issues/${n}/comments`, { per_page: 100 });
        out.comments_list = (c.data as Any[]).map(slimComment);
      }
      if (a.include_checks && r.data.head?.sha) {
        const { sha: _sha, ...checks } = await commitChecks(gh, owner, repo, r.data.head.sha);
        Object.assign(out, checks);
      }
      const c = clip(JSON.stringify(out), a.max_chars);
      return c.truncated ? { ...slimPr(r.data, false), truncated: true, note: "output too large; request fewer include_* or raise max_chars" } : out;
    },
  },
  {
    name: "gh_pr_create",
    description: "Open a pull request from head branch into base (default: default branch).",
    inputSchema: S(
      { ...REPO_PROPS, title: str("Title"), head: str("Head branch ('user:branch' for forks)"), base: str("Base branch (default: default branch)"), body: str("Markdown body"), draft: bool("Create as draft"), maintainer_can_modify: bool("Allow maintainers to edit (default true)") },
      ["repo", "title", "head"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const base = opt<string>(a, "base") ?? (await defaultBranch(ctx.gh, owner, repo));
      const r = await ctx.gh.post<Any>(`/repos/${owner}/${repo}/pulls`, { title: need(a, "title"), head: need(a, "head"), base, body: opt(a, "body"), draft: opt(a, "draft"), maintainer_can_modify: opt(a, "maintainer_can_modify") });
      return slimPr(r.data);
    },
  },
  {
    name: "gh_pr_update",
    description: "Update a pull request: title, body, state (open/closed), base branch. To toggle draft use gh_graphql (convertPullRequestToDraft / markPullRequestReadyForReview).",
    inputSchema: S({ ...REPO_PROPS, number: int("PR number"), title: str("Title"), body: str("Body"), state: enumOf("State", ["open", "closed"]), base: str("New base branch"), maintainer_can_modify: bool("Allow maintainer edits") }, ["repo", "number"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.patch<Any>(`/repos/${owner}/${repo}/pulls/${need(a, "number")}`, pick(a, ["title", "body", "state", "base", "maintainer_can_modify"]));
      return slimPr(r.data);
    },
  },
  {
    name: "gh_pr_files",
    description: "List files changed by a PR, optionally with patch hunks.",
    inputSchema: S({ ...REPO_PROPS, number: int("PR number"), include_patch: bool("Include patch text (default false)"), per_page: PER_PAGE, page: PAGE, max_chars: MAX_CHARS }, ["repo", "number"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/pulls/${need(a, "number")}/files`, paging(a));
      const items = (r.data as Any[]).map((f) => slimFile(f, Boolean(a.include_patch)));
      const c = clip(JSON.stringify(items), a.max_chars);
      return c.truncated ? { items: c.text, truncated: true, next_page: nextPage(r.headers) } : { items, next_page: nextPage(r.headers) };
    },
  },
  {
    name: "gh_pr_diff",
    description: "Get the unified diff (or patch) of a PR as text.",
    inputSchema: S({ ...REPO_PROPS, number: int("PR number"), format: enumOf("diff or patch", ["diff", "patch"], { default: "diff" }), max_chars: MAX_CHARS }, ["repo", "number"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<string>(`/repos/${owner}/${repo}/pulls/${need(a, "number")}`, undefined, `application/vnd.github.${a.format === "patch" ? "patch" : "diff"}`);
      const c = clip(String(r.data), a.max_chars);
      return { diff: c.text, truncated: c.truncated, total_chars: c.total_chars };
    },
  },
  {
    name: "gh_pr_merge",
    description: "Merge a pull request (merge / squash / rebase). Optionally require the head sha to match.",
    inputSchema: S(
      { ...REPO_PROPS, number: int("PR number"), merge_method: enumOf("Method", ["merge", "squash", "rebase"], { default: "squash" }), commit_title: str("Commit title"), commit_message: str("Commit message"), sha: str("Head sha that must match") },
      ["repo", "number"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.put<Any>(`/repos/${owner}/${repo}/pulls/${need(a, "number")}/merge`, { merge_method: a.merge_method ?? "squash", commit_title: opt(a, "commit_title"), commit_message: opt(a, "commit_message"), sha: opt(a, "sha") });
      return { merged: r.data.merged, sha: r.data.sha, message: r.data.message };
    },
  },
  {
    name: "gh_pr_review",
    description: "Submit a review: APPROVE, REQUEST_CHANGES or COMMENT, optionally with inline comments (path + line on the RIGHT side of the diff by default).",
    inputSchema: S(
      {
        ...REPO_PROPS,
        number: int("PR number"),
        event: enumOf("Review action", ["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
        body: str("Review summary (required for REQUEST_CHANGES/COMMENT)"),
        comments: arr("Inline comments", S({ path: str("File path"), line: int("Line number in the diff (new file line for side=RIGHT)"), side: enumOf("LEFT or RIGHT", ["LEFT", "RIGHT"]), start_line: int("For multi-line comments"), body: str("Comment body") }, ["path", "line", "body"])),
        commit_id: str("Head sha the review applies to (default: latest)"),
      },
      ["repo", "number", "event"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const comments = (opt<Any[]>(a, "comments") ?? []).map((c) => ({ path: c.path, line: c.line, side: c.side ?? "RIGHT", start_line: c.start_line, start_side: c.start_line ? (c.side ?? "RIGHT") : undefined, body: c.body }));
      const r = await ctx.gh.post<Any>(`/repos/${owner}/${repo}/pulls/${need(a, "number")}/reviews`, { event: need(a, "event"), body: opt(a, "body"), comments: comments.length ? comments : undefined, commit_id: opt(a, "commit_id") });
      return slimReview(r.data);
    },
  },
  {
    name: "gh_pr_reviews_list",
    description: "List reviews and inline review comments of a PR.",
    inputSchema: S({ ...REPO_PROPS, number: int("PR number"), per_page: PER_PAGE, page: PAGE }, ["repo", "number"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const n = need(a, "number");
      const rv = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/pulls/${n}/reviews`, paging(a));
      const rc = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/pulls/${n}/comments`, paging(a));
      return { reviews: (rv.data as Any[]).map(slimReview), review_comments: (rc.data as Any[]).map(slimReviewComment), next_page: nextPage(rc.headers) };
    },
  },
  {
    name: "gh_pr_review_comment_reply",
    description: "Reply to an inline review comment (creates a thread reply).",
    inputSchema: S({ ...REPO_PROPS, number: int("PR number"), comment_id: int("Review comment id to reply to"), body: str("Reply body") }, ["repo", "number", "comment_id", "body"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.post<Any>(`/repos/${owner}/${repo}/pulls/${need(a, "number")}/comments/${need(a, "comment_id")}/replies`, { body: need(a, "body") });
      return slimReviewComment(r.data);
    },
  },
  {
    name: "gh_pr_request_reviewers",
    description: "Request (or remove) reviewers on a PR.",
    inputSchema: S({ ...REPO_PROPS, number: int("PR number"), reviewers: arr("Logins", str("login")), team_reviewers: arr("Team slugs", str("slug")), remove: bool("Remove instead of request") }, ["repo", "number"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const body = { reviewers: opt(a, "reviewers"), team_reviewers: opt(a, "team_reviewers") };
      const path = `/repos/${owner}/${repo}/pulls/${need(a, "number")}/requested_reviewers`;
      const r = a.remove ? await ctx.gh.del<Any>(path, body) : await ctx.gh.post<Any>(path, body);
      return { requested_reviewers: (r.data.requested_reviewers ?? []).map(login), requested_teams: (r.data.requested_teams ?? []).map((t: Any) => t.slug) };
    },
  },
  {
    name: "gh_pr_update_branch",
    description: "Update the PR head branch with the latest base branch (merge base into head).",
    inputSchema: S({ ...REPO_PROPS, number: int("PR number"), expected_head_sha: str("Guard: head sha must equal this") }, ["repo", "number"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.put<Any>(`/repos/${owner}/${repo}/pulls/${need(a, "number")}/update-branch`, { expected_head_sha: opt(a, "expected_head_sha") });
      return { status: r.status, message: r.data?.message, url: r.data?.url };
    },
  },
  {
    name: "gh_checks",
    description: "Check runs and combined commit status for a ref (branch, tag or sha). Use with a PR head sha to see CI state. If the token cannot read check runs (fine-grained PAT), returns the GitHub Actions workflow runs for that sha instead.",
    inputSchema: S({ ...REPO_PROPS, ref: str("Branch, tag or commit sha"), check_name: str("Only this check run name"), status: enumOf("Filter by status", ["queued", "in_progress", "completed"]) }, ["repo", "ref"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      return commitChecks(ctx.gh, owner, repo, need(a, "ref"), { check_name: opt(a, "check_name"), status: opt(a, "status") });
    },
  },

  // ----- actions -----
  {
    name: "gh_workflows_list",
    description: "List GitHub Actions workflows of a repo (id, name, file path, state).",
    inputSchema: S({ ...REPO_PROPS }, ["repo"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/actions/workflows`, { per_page: 100 });
      return { items: (r.data.workflows as Any[]).map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state, html_url: w.html_url })) };
    },
  },
  {
    name: "gh_actions_runs_list",
    description: "List workflow runs. Filter by workflow (id or file name like ci.yml), branch, status, event, actor, head_sha.",
    inputSchema: S(
      {
        ...REPO_PROPS,
        workflow: str("Workflow id or file name (e.g. ci.yml). Omit for all workflows."),
        branch: str("Branch"),
        status: enumOf("Status/conclusion filter", ["queued", "in_progress", "completed", "success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral", "stale", "waiting", "pending", "requested"]),
        event: str("Trigger event, e.g. push, pull_request, workflow_dispatch, schedule"),
        actor: str("Login"),
        head_sha: str("Commit sha"),
        per_page: PER_PAGE,
        page: PAGE,
      },
      ["repo"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const wf = opt<string>(a, "workflow");
      const path = wf ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(wf)}/runs` : `/repos/${owner}/${repo}/actions/runs`;
      const r = await ctx.gh.get<Any>(path, { branch: opt(a, "branch"), status: opt(a, "status"), event: opt(a, "event"), actor: opt(a, "actor"), head_sha: opt(a, "head_sha"), ...paging(a) });
      return { total_count: r.data.total_count, items: (r.data.workflow_runs as Any[]).map(slimRun), next_page: nextPage(r.headers) };
    },
  },
  {
    name: "gh_actions_run_get",
    description: "Get a workflow run with its jobs and step results.",
    inputSchema: S({ ...REPO_PROPS, run_id: int("Run id"), include_jobs: bool("Include jobs (default true)", { default: true }) }, ["repo", "run_id"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const id = need(a, "run_id");
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/actions/runs/${id}`);
      const out: Any = { ...slimRun(r.data), path: r.data.path, display_title: r.data.display_title, run_started_at: r.data.run_started_at, pull_requests: (r.data.pull_requests ?? []).map((p: Any) => p.number) };
      if (a.include_jobs === undefined || a.include_jobs) {
        const j = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/actions/runs/${id}/jobs`, { per_page: 100, filter: "latest" });
        out.jobs = (j.data.jobs as Any[]).map(slimJob);
      }
      return out;
    },
  },
  {
    name: "gh_actions_job_logs",
    description: "Fetch the plain-text log of a job (from gh_actions_run_get jobs[].id). Returns the last tail_lines lines; grep (regex, case-insensitive) filters lines first, with optional context_lines.",
    inputSchema: S(
      { ...REPO_PROPS, job_id: int("Job id"), tail_lines: int("Lines to return from the end (default 200)", { minimum: 1 }), grep: str("Regex to filter lines (e.g. 'error|failed|✗')"), context_lines: int("Lines of context around grep matches (default 0)"), max_chars: MAX_CHARS },
      ["repo", "job_id"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const text = await fetchJobLogs(ctx.gh, `/repos/${owner}/${repo}/actions/jobs/${need(a, "job_id")}/logs`);
      const t = tailAndGrep(text, a);
      const c = clip(t.lines, a.max_chars);
      return { total_lines: t.total_lines, matched_lines: t.matched, log: c.text, truncated: c.truncated };
    },
  },
  {
    name: "gh_actions_run_logs_failed",
    description: "Shortcut: for a run, find failed jobs and return the tail of each failed job's log (around failing steps). Best first call when CI is red.",
    inputSchema: S({ ...REPO_PROPS, run_id: int("Run id"), tail_lines: int("Lines per job (default 120)"), grep: str("Optional regex filter applied to each log") }, ["repo", "run_id"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const id = need(a, "run_id");
      const j = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/actions/runs/${id}/jobs`, { per_page: 100, filter: "latest" });
      const failed = (j.data.jobs as Any[]).filter((x) => x.conclusion && !["success", "skipped", "neutral"].includes(x.conclusion));
      const out: Any[] = [];
      for (const job of failed.slice(0, 5)) {
        const failedSteps = (job.steps ?? []).filter((s: Any) => s.conclusion === "failure").map((s: Any) => s.name);
        try {
          const text = await fetchJobLogs(ctx.gh, `/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`);
          const t = tailAndGrep(text, { tail_lines: a.tail_lines ?? 120, grep: opt(a, "grep"), context_lines: 2 });
          out.push({ job_id: job.id, name: job.name, conclusion: job.conclusion, failed_steps: failedSteps, html_url: job.html_url, log_tail: clip(t.lines, 20000).text });
        } catch (e) {
          out.push({ job_id: job.id, name: job.name, conclusion: job.conclusion, failed_steps: failedSteps, html_url: job.html_url, log_error: (e as Error).message });
        }
      }
      return { run_id: id, failed_jobs: failed.length, jobs: out };
    },
  },
  {
    name: "gh_workflow_dispatch",
    description: "Trigger a workflow_dispatch run of a workflow (id or file name) on a ref with inputs.",
    inputSchema: S({ ...REPO_PROPS, workflow: str("Workflow id or file name, e.g. deploy.yml"), ref: str("Branch or tag"), inputs: obj("Workflow inputs") }, ["repo", "workflow", "ref"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.post<Any>(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(need(a, "workflow"))}/dispatches`, { ref: need(a, "ref"), inputs: opt(a, "inputs") });
      return { status: r.status, dispatched: r.status === 204, hint: "List runs with gh_actions_runs_list (event=workflow_dispatch) after a few seconds." };
    },
  },
  {
    name: "gh_actions_run_rerun",
    description: "Re-run a workflow run (all jobs, or failed jobs only).",
    inputSchema: S({ ...REPO_PROPS, run_id: int("Run id"), failed_only: bool("Only re-run failed jobs (default false)") }, ["repo", "run_id"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.post<Any>(`/repos/${owner}/${repo}/actions/runs/${need(a, "run_id")}/${a.failed_only ? "rerun-failed-jobs" : "rerun"}`);
      return { status: r.status, ok: r.status === 201 };
    },
  },
  {
    name: "gh_actions_run_cancel",
    description: "Cancel a workflow run.",
    inputSchema: S({ ...REPO_PROPS, run_id: int("Run id") }, ["repo", "run_id"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.post<Any>(`/repos/${owner}/${repo}/actions/runs/${need(a, "run_id")}/cancel`);
      return { status: r.status, ok: r.status === 202 };
    },
  },

  // ----- releases / tags -----
  {
    name: "gh_releases_list",
    description: "List releases (newest first).",
    inputSchema: S({ ...REPO_PROPS, per_page: PER_PAGE, page: PAGE }, ["repo"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/releases`, paging(a));
      return { items: (r.data as Any[]).map(slimRelease), next_page: nextPage(r.headers) };
    },
  },
  {
    name: "gh_release_create",
    description: "Create a release (and tag if it does not exist).",
    inputSchema: S(
      { ...REPO_PROPS, tag_name: str("Tag, e.g. v1.2.0"), target_commitish: str("Branch or sha to tag (default: default branch)"), name: str("Release title"), body: str("Release notes"), draft: bool("Draft"), prerelease: bool("Pre-release"), generate_release_notes: bool("Auto-generate notes") },
      ["repo", "tag_name"],
    ),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.post<Any>(`/repos/${owner}/${repo}/releases`, pick(a, ["tag_name", "target_commitish", "name", "body", "draft", "prerelease", "generate_release_notes"]));
      return slimRelease(r.data);
    },
  },
  {
    name: "gh_tags_list",
    description: "List tags.",
    inputSchema: S({ ...REPO_PROPS, per_page: PER_PAGE, page: PAGE }, ["repo"]),
    handler: async (a, ctx) => {
      const { owner, repo } = repoOf(a, ctx);
      const r = await ctx.gh.get<Any>(`/repos/${owner}/${repo}/tags`, paging(a));
      return { items: (r.data as Any[]).map((t) => ({ name: t.name, sha: shortSha(t.commit?.sha) })), next_page: nextPage(r.headers) };
    },
  },

  // ----- notifications -----
  {
    name: "gh_notifications_list",
    description: "List the authenticated user's notifications (requires 'notifications' scope on a classic PAT).",
    inputSchema: S({ all: bool("Include read notifications"), participating: bool("Only where participating/mentioned"), since: str("ISO 8601"), per_page: PER_PAGE, page: PAGE }),
    handler: async (a, { gh }) => {
      const r = await gh.get<Any>("/notifications", { all: opt(a, "all"), participating: opt(a, "participating"), since: opt(a, "since"), ...paging(a) });
      return {
        items: (r.data as Any[]).map((n) => ({
          id: n.id,
          reason: n.reason,
          unread: n.unread,
          repo: n.repository?.full_name,
          subject: { title: n.subject?.title, type: n.subject?.type, number: n.subject?.url ? Number(String(n.subject.url).split("/").pop()) : undefined },
          updated_at: n.updated_at,
        })),
        next_page: nextPage(r.headers),
      };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Executes tools/call. Errors are returned as isError results (not JSON-RPC errors) so the model can read them */
export async function callTool(name: string, args: Args, ctx: Ctx): Promise<{ content: { type: "text"; text: string }[]; isError: boolean }> {
  const tool = TOOL_MAP.get(name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  try {
    const result = await tool.handler(args ?? {}, ctx);
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 1) }], isError: false };
  } catch (e) {
    if (e instanceof ArgError) return { content: [{ type: "text", text: `Invalid arguments: ${e.message}` }], isError: true };
    if (e instanceof GhError) {
      const hint =
        e.status === 401
          ? " (GITHUB_TOKEN rejected: expired/revoked? rotate with wrangler secret put GITHUB_TOKEN)"
          : e.status === 403
            ? " (forbidden: token lacks permission for this repo/scope, or rate-limited — check gh_status)"
            : e.status === 404
              ? " (not found: wrong owner/repo/number, or the token cannot see this private repo)"
              : "";
      return { content: [{ type: "text", text: `${e.message}${hint}` }], isError: true };
    }
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }
}
