# Hosted Life Diff privacy

This describes the service at `https://lifediff.dev`. The [local Google snapshot workflow](docs/local-google.md#local-data) uses its own read-only OAuth setup and keeps its files on the machine running it.

## Data the hosted service stores

- GitHub user ID and login, the GitHub App installation IDs returned by GitHub, and encrypted GitHub access and refresh tokens. GitHub signs you into the service. Repository checks require app access and a list of repositories you name for the session.
- When a session checks GitHub, snapshots and changes can include branch names, commit IDs and messages, pull request and issue titles and labels, comments, and file paths. GitHub file changes use line counts such as `+10 −2`. The GitHub verification feed reads metadata and does not store repository file bodies or patches.
- Operator-approved upstream MCP server URLs, optional encrypted credentials, and account preferences including time zone, end of workday, idle minutes, and daily GitHub and quiet-day settings.
- For tool calls routed through Life Diff, the upstream and tool name, bounded arguments, timing and outcomes, a short result or error excerpt, and a client name when available. Explicit agent reports may include details and before/after text. Ordinary text in those fields can include file content, messages, or document content. Receipt JSON, HTML and generated cards, and daily roundups can include this material.
- MCP OAuth grants and Life Diff tokens. Grant properties identify the GitHub user ID, login, and account version for access revocation. Clients receive Life Diff access, not the GitHub credential.

Life Diff masks values in secret-like keys and recognizes patterns such as bearer credentials, secret assignments in text, and common token formats. This redaction is best effort. Arbitrary private text and unrecognized secrets can survive in storage and display. A forwarded tool receives the original arguments. Upstream credentials are encrypted at rest and sent only to the approved final endpoint. A redirect ends the call. Use the token field for credentials. URLs with queries, fragments, or embedded credentials are blocked. Existing blocked URLs stay hidden in Settings and client results until the registration is removed. Hosted Life Diff does not access Google directly as a data provider. A Google tool used through an upstream can still send Google-derived content through the proxy.

## Access and signed links

- The GitHub callback sets a seven-day signed browser session cookie. Open Settings and Today in the browser that completed sign-in. An approved MCP client uses its own Life Diff token.
- `end_session`, `get_receipt`, and `get_daily_diff` can provide a signed HTML view link scoped to one receipt or day. Anyone with the link can open that report for **24 hours** without a browser session, while the data is available. A link for the current day can reflect new activity on that day.
- Daily card links expire after 24 hours. Receipt card links use separate access tokens and can open their image while the stored card is available. Treat both kinds of URLs as access credentials. Keep them out of shared chat, issues, screenshots, and logs.
- Signed HTML responses request no storage by browser or intermediary caches and no referrer forwarding. Recipients can still retain a copy. Undo prompt pages require the account's browser session or an authorized Life Diff token.

## Retention and deletion

By default, receipts expire after **90 days**, snapshots of closed sessions after **24 hours**, and abandoned open sessions after **seven days**. Maintenance runs hourly. Daily roundups have no separate age limit. An idle session can be finalized before the abandoned-session limit.

- **Clear my history** on [Settings](https://lifediff.dev/settings) deletes sessions, action history, snapshots, saved receipts, and daily roundups. It invalidates previously issued receipt and roundup links, including day links if new activity is recorded for the same date. Account sign-in, preferences, upstream registrations, and approved MCP clients stay.
- **Delete my Life Diff data** on [Account](https://lifediff.dev/account) also removes the Life Diff account, settings, registered upstreams, and encrypted credentials. It revokes MCP grants and invalidates browser sessions, even on other devices and after a new sign-in with the same GitHub account. Upstream data and GitHub authorization are managed separately. Use GitHub's installed or authorized GitHub App settings to revoke the app on GitHub.

Both controls require browser sign-in and an explicit confirmation. When the hardening update first goes live, get fresh signed HTML and daily image links from your client as needed.
