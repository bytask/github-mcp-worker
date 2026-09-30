/**
 * GitHub API client (REST + GraphQL): a thin wrapper around fetch to api.github.com.
 * - Authenticates with the Worker Secret GITHUB_TOKEN (one PAT, single user)
 * - redirect is manual, so redirects (e.g. to log blob storage) are followed without the Authorization header
 */

export interface Env {
  ACCESS_TEAM_DOMAIN?: string; // https://<team>.cloudflareaccess.com
  ACCESS_AUD?: string; // Application Audience (AUD) tag of the Access application
  GITHUB_TOKEN?: string;
  DEFAULT_OWNER?: string;
  GITHUB_API?: string;
}

export class GhError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface RequestOpts {
  query?: Record<string, unknown>;
  body?: unknown;
  accept?: string;
  headers?: Record<string, string>;
}

export interface GhResponse<T = unknown> {
  status: number;
  data: T;
  headers: Headers;
}

const USER_AGENT = "github-mcp-worker/1.0 (+cloudflare-workers)";

export function createClient(env: Env) {
  const base = (env.GITHUB_API || "https://api.github.com").replace(/\/$/, "");
  const token = env.GITHUB_TOKEN ?? "";

  function buildUrl(path: string, query?: Record<string, unknown>): URL {
    const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(base + (path.startsWith("/") ? path : `/${path}`));
    // The token is attached, so full URLs must share the API origin (never leak the PAT to another host via gh_api)
    if (url.origin !== new URL(base).origin) throw new GhError(400, `Refusing to send the token to ${url.origin}: only ${new URL(base).origin} is allowed`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return url;
  }

  async function raw(method: string, path: string, opts: RequestOpts = {}): Promise<Response> {
    const url = buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: opts.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT,
      ...(opts.headers ?? {}),
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }
    return fetch(url.toString(), { method, headers, body, redirect: "manual" });
  }

  async function request<T = unknown>(method: string, path: string, opts: RequestOpts = {}): Promise<GhResponse<T>> {
    const res = await raw(method, path, opts);
    const text = await res.text();
    let data: unknown = text;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("json") && text) {
      try {
        data = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    if (res.status >= 400) {
      const msg =
        typeof data === "object" && data !== null && "message" in data
          ? String((data as { message: unknown }).message)
          : text.slice(0, 500);
      const errs =
        typeof data === "object" && data !== null && "errors" in data ? ` ${JSON.stringify((data as { errors: unknown }).errors).slice(0, 500)}` : "";
      throw new GhError(res.status, `GitHub API ${res.status} ${method} ${path}: ${msg}${errs}`, data);
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  return {
    raw,
    request,
    get: <T = unknown>(path: string, query?: Record<string, unknown>, accept?: string) => request<T>("GET", path, { query, accept }),
    post: <T = unknown>(path: string, body?: unknown, query?: Record<string, unknown>) => request<T>("POST", path, { body, query }),
    patch: <T = unknown>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
    put: <T = unknown>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
    del: <T = unknown>(path: string, body?: unknown) => request<T>("DELETE", path, { body }),
    graphql: async <T = unknown>(query: string, variables?: Record<string, unknown>) => {
      const r = await request<{ data?: T; errors?: unknown[] }>("POST", "/graphql", { body: { query, variables } });
      if (r.data.errors && r.data.errors.length) {
        throw new GhError(200, `GraphQL errors: ${JSON.stringify(r.data.errors).slice(0, 1000)}`, r.data.errors);
      }
      return r.data.data as T;
    },
  };
}

export type Gh = ReturnType<typeof createClient>;

/** Extracts the next page number from a Link header */
export function nextPage(headers: Headers): number | undefined {
  const link = headers.get("link");
  if (!link) return undefined;
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  if (!m) return undefined;
  const p = new URL(m[1]).searchParams.get("page");
  return p ? Number(p) : undefined;
}

/** base64 (with newlines) → UTF-8 string; also returns bytes for binary detection */
export function decodeBase64(b64: string): { bytes: Uint8Array; text: string; binary: boolean } {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const head = bytes.subarray(0, Math.min(bytes.length, 8000));
  const binary = head.includes(0);
  const text = binary ? "" : new TextDecoder("utf-8").decode(bytes);
  return { bytes, text, binary };
}

export function encodeBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
