# github-mcp-worker

A self-hosted GitHub MCP server on Cloudflare Workers. It exposes the GitHub REST / GraphQL API as 51 `gh_*` tools over Streamable HTTP, and uses **Cloudflare Access Managed OAuth** for sign-in — so you can add it to claude.ai as a custom connector with a normal "Sign in" flow, without writing any OAuth code or putting a secret in the URL.

```
MCP client (claude.ai custom connector, Claude Code, ...)
  → https://github-mcp.example.com/mcp
    Cloudflare Access application (Managed OAuth, your allow policy)
      unauthenticated → 401 + WWW-Authenticate (resource_metadata) → client registers (DCR) → Access login → consent → token
      authenticated   → request forwarded with Cf-Access-Jwt-Assertion
    → Worker verifies the JWT (signature / aud / iss / exp) → calls api.github.com with your GITHUB_TOKEN
```

Why this instead of a hosted GitHub connector:

- **Output is trimmed** to what a model needs; large bodies are cut at `max_chars` (default 60,000) with `truncated: true`.
- **Writes are first-class**: multi-file commits in one call (`gh_push_files`), PR create / review / merge, Actions rerun / dispatch.
- **Escape hatches**: `gh_api` (any REST path) and `gh_graphql` for anything not covered.
- **You own it**: one Worker, one PAT, access decided by your own Access policy.

## Tools

| Area | Tools |
|---|---|
| Status / generic | `gh_status` `gh_api` `gh_graphql` `gh_search` |
| Repos / contents | `gh_repos_list` `gh_repo_get` `gh_repo_create` `gh_file_get` `gh_tree` `gh_file_put` `gh_file_delete` `gh_push_files` |
| Branches / commits | `gh_branches_list` `gh_branch_create` `gh_branch_delete` `gh_commits_list` `gh_commit_get` `gh_compare` |
| Issues | `gh_issues_list` `gh_issue_get` `gh_issue_create` `gh_issue_update` `gh_issue_comment` `gh_issue_comments_list` `gh_comment_update` `gh_labels_list` |
| Pull requests | `gh_prs_list` `gh_pr_get` `gh_pr_create` `gh_pr_update` `gh_pr_files` `gh_pr_diff` `gh_pr_merge` `gh_pr_review` `gh_pr_reviews_list` `gh_pr_review_comment_reply` `gh_pr_request_reviewers` `gh_pr_update_branch` |
| CI / Actions | `gh_checks` `gh_workflows_list` `gh_actions_runs_list` `gh_actions_run_get` `gh_actions_job_logs` `gh_actions_run_logs_failed` `gh_workflow_dispatch` `gh_actions_run_rerun` `gh_actions_run_cancel` |
| Releases / misc | `gh_releases_list` `gh_release_create` `gh_tags_list` `gh_notifications_list` |

Until `GITHUB_TOKEN` is set, only `gh_status` is listed and it returns setup steps.

## Requirements

- A Cloudflare account with a zone (domain) on it — Access protects a hostname, so `workers.dev` alone is not enough
- Cloudflare Zero Trust (the free plan is fine) with at least one login method (e.g. One-time PIN, Google, GitHub)
- A GitHub personal access token
- Node.js 22.6+ (for the tests)

## Setup

### 1. GitHub token

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) for the repositories you want to use:

| Permission | Access |
|---|---|
| Contents, Issues, Pull requests, Actions, Workflows, Commit statuses | Read and write |
| Administration | Read and write (only if you want `gh_repo_create`) |
| Metadata | Read |

Fine-grained tokens cannot read check runs or notifications. `gh_checks` falls back to Actions workflow runs for the same commit; `gh_notifications_list` returns 403. If you need those, use a classic token with `repo`, `workflow`, `read:org`, `notifications` — but note that a classic token reaches every repository your account can.

### 2. Access application with Managed OAuth

Create a self-hosted Access application for the hostname you will serve the Worker on, with Managed OAuth and Dynamic Client Registration enabled. The dashboard does not expose every OAuth field, so the API is easiest (the token needs *Access: Apps and Policies Edit*):

```sh
ACCOUNT_ID=<your account id>
HOST=github-mcp.example.com

curl -s https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "type": "self_hosted",
  "name": "github-mcp",
  "domain": "$HOST",
  "destinations": [{ "type": "public", "uri": "$HOST" }],
  "app_launcher_visible": false,
  "session_duration": "24h",
  "policies": [{
    "name": "Allow me",
    "decision": "allow",
    "include": [{ "email": { "email": "you@example.com" } }]
  }],
  "oauth_configuration": {
    "enabled": true,
    "grant": { "session_duration": "720h", "access_token_lifetime": "15m" },
    "dynamic_client_registration": {
      "enabled": true,
      "allowed_uris": [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback"
      ],
      "allow_any_on_localhost": true,
      "allow_any_on_loopback": true
    }
  }
}
JSON
```

From the response, note `result.aud` (the Application Audience tag). Your team domain is `https://<team>.cloudflareaccess.com` (Zero Trust → Settings).

- `grant.session_duration` is how long a client stays connected before signing in again. The dashboard only offers up to one month; longer values can be set through the API, and the dashboard will then show the field as empty. Change such an app through the API (PUT with the full object) rather than saving it in the dashboard.
- Add other MCP clients' callback URLs to `allowed_uris` if you use them. Loopback / localhost cover Claude Code and local testing.
- Who can connect is decided only by the Access policy. Anyone allowed there uses **your** GitHub token.

See Cloudflare's [Managed OAuth docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) for details.

### 3. Deploy the Worker

Edit the `TODO` values in `wrangler.jsonc` (`routes`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, optionally `DEFAULT_OWNER`), then:

```sh
npm install
npm run typecheck
npm test                                  # unit tests (no network)
npx wrangler secret put GITHUB_TOKEN      # paste the token from step 1
npm run deploy
```

Check that an unauthenticated request is stopped by Access:

```sh
curl -si -X POST https://github-mcp.example.com/mcp -d '{}' | grep -i -E '^HTTP|www-authenticate'
# HTTP/2 401
# www-authenticate: Bearer ... resource_metadata="https://github-mcp.example.com/.well-known/oauth-protected-resource..."
```

If you get 403 or error 1010 instead, a zone security feature (Bot Fight Mode, WAF) is blocking non-browser clients on that hostname.

### 4. Connect a client

**claude.ai** — Settings → Connectors → Add custom connector → URL `https://github-mcp.example.com/mcp` → Add → Connect. Sign in through Access and allow the consent screen. Claude Code can then use the connector as well when you are logged in with the same claude.ai account.

**Claude Code (direct)**:

```sh
claude mcp add --transport http github https://github-mcp.example.com/mcp
```

Then run `/mcp` in Claude Code and authenticate.

## How it works

- **Stateless**: no `Mcp-Session-Id`, no SSE; each POST is an independent JSON-RPC request (batches supported).
- **Fail closed**: `/mcp` returns 500 if `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` are missing, and 403 if the Access JWT is absent or invalid. The JWT is verified against the team's public keys (`/cdn-cgi/access/certs`, cached for an hour, refetched on an unknown `kid`).
- **Token containment**: `gh_api` accepts full URLs only on the `GITHUB_API` origin, so the PAT is never sent elsewhere. Redirects (e.g. Actions logs on blob storage) are followed without the Authorization header.
- **Logs**: `gh_actions_job_logs` / `gh_actions_run_logs_failed` support `grep` and `tail_lines` so a model doesn't pull megabytes of logs.

## Operations

| Task | How |
|---|---|
| Logs | `npm run tail` |
| Rotate the GitHub token | `npx wrangler secret put GITHUB_TOKEN`. A revoked or expired token shows up as 401 in `gh_status` |
| Allow more people | Add them to the Access policy. They all act as the token's owner on GitHub |
| Disconnect all clients | Access application → Revoke existing tokens; clients reconnect with Connect |
| Recreated the Access app | The AUD changes; update `ACCESS_AUD` and redeploy |
| Smoke test | `MCP_URL=https://<host>/mcp npm test` checks the 401; add `MCP_TOKEN=<Access OAuth access token>` and `GITHUB_MCP_SMOKE_REPO=owner/repo` to exercise the tools |

Costs: the Worker fits the Workers free plan for personal use, Access is within the Zero Trust free plan (up to 50 users), and the GitHub API is free (5,000 requests/hour per token).

## Limitations

- Single GitHub identity: every allowed user acts through one token. For per-user GitHub identities you would need a GitHub App or GitHub OAuth instead.
- `gh_checks` cannot show check-run details with a fine-grained token (see step 1).

## License

MIT
