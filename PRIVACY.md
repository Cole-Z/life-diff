# Life Diff privacy draft

This is a draft for Cole to review before the hosted service is deployed. It describes the hosted Worker at `https://lifediff.dev`. The self-run command is different: it keeps Google Calendar and Drive data on the machine that runs it, and hosted Life Diff does not use Google at all.

## What is stored

For a person who installs the GitHub App and signs in:

- GitHub user id and login.
- The GitHub user-to-server access token and refresh token, encrypted with AES-GCM. The key is a Worker secret and is not stored next to the token.
- GitHub App installation ids and the account login GitHub returns with them.
- A session snapshot of repository metadata: branch names and commit ids, pull request and issue titles and labels, and later the commits, comments, and file paths that changed. File bodies and patches are not stored. A file change is recorded as a line count such as `+10 −2`.
- MCP servers you register: a name, an https URL, and, when you provide one, a token encrypted with the same AES-GCM key. The token is not returned to the agent or shown on the settings page.
- An action log of tool calls Life Diff forwarded, with arguments redacted, plus claims an agent logged (`log_action` or `POST /v1/sessions/:id/actions`). The forwarded call is sent to the upstream you registered. Life Diff does not otherwise run those tools.
- Receipt JSON and the HTML report, in object storage, plus counts and expiry in the database.
- MCP access grants issued by Life Diff. A grant records the GitHub user id and login only. It does not contain the GitHub token. MCP clients receive a Life Diff token, not the GitHub token.

## What is not stored

- Google account data, calendars, or Drive files.
- Repository file contents or unified diffs.
- The GitHub token inside an MCP token or an MCP grant.
- Webhook deliveries. The GitHub App webhook stays off. Life Diff reads GitHub when a session starts and when it ends.

## How long it is kept

These are the defaults baked into the Worker configuration:

- Receipts are deleted 90 days after they are created.
- After a session ends, the snapshot is deleted 24 hours later.
- An open session that is never ended is deleted after 7 days, along with its snapshot and action log.

A daily job applies those limits. Deleting a receipt or snapshot removes both the database row and the stored object.

## How to delete it

- In a browser, after GitHub has sent you back to Life Diff, open `https://lifediff.dev/account` and use **Delete my Life Diff data**. That form posts to `/account/delete` with a CSRF token.
- An agent with a Life Diff token can call `DELETE https://lifediff.dev/v1/me`.

Deletion removes the user row, the encrypted GitHub token, installation ids, sessions, the action log, snapshots, receipts, and Life Diff MCP grants. It does not change GitHub. Uninstall the Life Diff GitHub App from GitHub settings separately. GitHub may keep its own copy of the authorization until that uninstall or a revoke on GitHub's side.

## Who can read it

The person who authorized the app, and MCP clients they approve, can read their receipts and log actions on their open session. Receipt HTML is served to that person's Life Diff token, and to the browser session set when GitHub sent them back to Life Diff. Tokens are checked against the resource `https://lifediff.dev/mcp`.

Deleting the account also deletes registered upstreams and their encrypted tokens.
