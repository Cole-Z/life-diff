# Hosted Life Diff

Hosted Life Diff is a Cloudflare Worker. It signs a person in with a GitHub App, snapshots the repositories that app is installed on, and writes a read-only receipt of what changed during an agent session. An MCP client talks to Life Diff. Life Diff talks to GitHub. The GitHub token never goes to the client.

This service does not use Google. Calendar and Drive stay in the self-run command, where each person brings their own OAuth client.

Nothing in this repository deploys the Worker or creates the GitHub App. The steps below are for Cole to run when he is ready.

## Domain

Use one origin, `https://lifediff.dev`, instead of a separate `mcp.lifediff.dev`.

| What | URL |
| --- | --- |
| Site, consent, and account | `https://lifediff.dev` |
| MCP endpoint | `https://lifediff.dev/mcp` |
| GitHub App callback | `https://lifediff.dev/callback` |
| OAuth issuer | `https://lifediff.dev` |
| Protected resource metadata | `https://lifediff.dev/.well-known/oauth-protected-resource/mcp` |

One origin keeps the GitHub callback, the consent cookie, the account page, and the MCP resource on the same host. The MCP resource URL has to be exactly `https://lifediff.dev/mcp`.

The custom domain route is commented out in `wrangler.toml`. `workers_dev` stays `true` until that route is uncommented. Do not attach the domain from CI.

Local development overrides the issuer and resource URL in `.dev.vars` (see `.dev.vars.example`):

```
ISSUER=http://localhost:8787
MCP_SERVER_URL=http://localhost:8787/mcp
```

`http` is only accepted on loopback. A development GitHub App, separate from the production app, can use `http://localhost:8787/callback`.

## What an agent can call

MCP tools, all of which require the scopes `receipts:read` and `sessions:write`:

- `start_session` takes a snapshot. A second snapshot is refused while a session is open.
- `end_session` re-reads GitHub, diffs the window, and stores a receipt.
- `get_receipt` returns a stored receipt. Pass `includeHtml` for the HTML report.
- `log_action` records a claimed action. Life Diff does not run the tool.
- `list_receipts` lists receipt metadata.

The same action log is available as `POST /v1/sessions/:id/actions` with the Life Diff bearer token. `DELETE /v1/me` deletes the account. Signed-in browsers can use `POST /account/delete` (the account page includes a CSRF token).

`log_action` is a pass-through record. If an agent routes a tool call through Life Diff, the receipt shows it as a claimed action and checks it against the GitHub diff when the names line up. Unknown actions do not match. One claim matches one change.

## Receipts

Receipts use schema `1.0.0`, the same top-level shape as the Go core (`docs/receipt-schema.md` on the core PR). Readers ignore unknown fields. Hosted receipts add a top-level `github` object, parallel to `calendar` and `drive`, and changes may include `resourceType`, `repo`, `actor`, `viaApp`, and `labelsChanged`. File `content` is a line count such as `+10 −2`, not a patch or file body.

The HTML report uses the same labels and colors as the core report: Added `#0f5c32`, Removed `#8d1c1c`, Modified `#6b4300`, and the same badge, icon, and confidence language. The lede says the receipt is a read-only record of GitHub changes. Links are limited to `https://github.com`.

## How a session is stored

| Store | Holds |
| --- | --- |
| Durable Object `UserSession` (one per GitHub user id) | Open session and the action log |
| D1 | User, encrypted GitHub credential, installation ids, session and receipt metadata |
| R2 `life-diff-receipts` | Snapshot JSON, receipt JSON, receipt HTML |
| KV `OAUTH_KV` | MCP grants and tokens issued by Life Diff |

MCP grant props are only `{ userId, login }`. `userId` is the numeric GitHub id. The GitHub access token is encrypted with AES-GCM under the `TOKEN_ENCRYPTION_KEY` secret and stored in D1. It is not copied into the grant.

Retention defaults:

- Receipts: 90 days
- Snapshots after a session ends: 24 hours
- Open sessions that are never ended: 7 days

A daily cron deletes expired receipts, expired snapshots, and abandoned sessions. It also purges expired OAuth rows.

## Architecture

One Worker, two entrypoints:

- `AuthServer` serves the authorization server, GitHub callback, consent, and account pages.
- The default export routes `/mcp` and the protected-resource metadata through `OAuthResourceServer`, `/v1` and `/receipts` through the data API, and everything else through `AuthServer`.

Token checks run in-process. A service binding from this Worker back to itself can deadlock, so `wrangler.toml` does not define one. If `env.AUTH_SERVER` is present, the resource server uses it. A future split is commented in `wrangler.toml`.

Life Diff issues its own MCP tokens. The GitHub user-to-server token is refreshed lazily and stays on the Worker. Consent is shown on every authorization. The OAuth `state` and PKCE values come from `@cloudflare/workers-oauth-provider` (`beginConsent`, `approveConsent`, `beginUpstream`, `finishUpstream`). The GitHub authorize request uses PKCE S256 and does not send a client secret or an OAuth `scope` parameter. GitHub App permissions are configured on the app, not on the authorize URL. Webhooks are off. `end_session` polls.

The snapshot reads at most 25 repositories. A truncated branch, pull, or issue page copies the missing before-state forward so those items are not reported as removed. A failed re-read of a repository suppresses removals for that repository. Compare results stop at 300 files or 250 commits.

## Create the GitHub App

In GitHub, create a GitHub App (user-to-server). Do not generate or download a private key. Leave the webhook inactive.

- Homepage URL: `https://lifediff.dev`
- Callback URL: `https://lifediff.dev/callback`
- Expire user authorization tokens: on (GitHub's default, about 8 hours, with a refresh token)
- Request a user to authorize the app during installation: on

Repository permissions, all read-only:

- Metadata
- Contents
- Pull requests
- Issues

No administration, no write permissions, and no account permissions beyond what GitHub requires to identify the authorizing user.

After the app exists, copy the client ID into `GITHUB_APP_CLIENT_ID` and the slug into `GITHUB_APP_SLUG` in `wrangler.toml` (or as a var). Put the client secret only in a secret:

```bash
cd hosted
npx wrangler secret put GITHUB_APP_CLIENT_SECRET
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
openssl rand -base64 48 | npx wrangler secret put COOKIE_SIGNING_KEY
```

`TOKEN_ENCRYPTION_KEY` must be base64 for 32 bytes. `COOKIE_SIGNING_KEY` must be at least 32 characters. Do not commit either value.

For local `wrangler dev`, put the same names in `hosted/.dev.vars` and point a separate GitHub App callback at `http://localhost:8787/callback`.

## Create the Cloudflare resources

Run these once, then replace the placeholder ids in `wrangler.toml`. They are not run by CI.

```bash
cd hosted
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create life-diff
npx wrangler r2 bucket create life-diff-receipts
npx wrangler d1 migrations apply life-diff --remote
```

When the `lifediff.dev` zone is on this account and you want production traffic on it, uncomment the `[[routes]]` block in `wrangler.toml` and set `workers_dev = false`. Then deploy with `npx wrangler deploy`. This pull request does not do that.

An MCP client should use `https://lifediff.dev/mcp` as the server URL. Life Diff's authorization server is `https://lifediff.dev`.

## Tests

```bash
cd hosted
npm ci
npm test
npm run typecheck
```

Tests use vitest in Node with fake GitHub responses. They do not call `api.github.com`. CI is `.github/workflows/hosted.yml`.
