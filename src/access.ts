/**
 * Verification of the Cloudflare Access JWT (Cf-Access-Jwt-Assertion).
 * This server is meant to sit only behind Access (Managed OAuth). Requests that passed Access carry a JWT signed by Access,
 * and the Worker verifies it too, so anything that bypasses Access (Service Bindings, misconfigured routes) is rejected.
 */

export interface AccessClaims {
  aud: string[];
  iss: string;
  exp: number;
  nbf?: number;
  email?: string;
  sub?: string;
  [k: string]: unknown;
}

const KEYS_TTL_MS = 60 * 60 * 1000;
let keysCache: { team: string; at: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

async function loadKeys(team: string, force: boolean): Promise<Map<string, CryptoKey>> {
  if (!force && keysCache && keysCache.team === team && Date.now() - keysCache.at < KEYS_TTL_MS) return keysCache.keys;
  const res = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs ${res.status}`);
  const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const map = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    map.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  keysCache = { team, at: Date.now(), keys: map };
  return map;
}

/** Returns the claims when the token is valid; throws with a reason otherwise. */
export async function verifyAccessJwt(token: string, opts: { team: string; aud: string }): Promise<AccessClaims> {
  const team = opts.team.replace(/\/$/, "");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = b64urlJson<{ alg?: string; kid?: string }>(parts[0]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported token header");
  let key = (await loadKeys(team, false)).get(header.kid);
  if (!key) key = (await loadKeys(team, true)).get(header.kid); // keys were just rotated
  if (!key) throw new Error("unknown signing key");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error("bad signature");
  const claims = b64urlJson<AccessClaims>(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud as unknown as string];
  if (!aud.includes(opts.aud)) throw new Error("audience mismatch");
  if (claims.iss !== team) throw new Error("issuer mismatch");
  if (typeof claims.exp !== "number" || claims.exp < now - 30) throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) throw new Error("not yet valid");
  return { ...claims, aud };
}
