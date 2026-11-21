# Life Diff privacy draft

This is a draft for Cole to review before the hosted service is deployed. It describes the hosted Worker at `https://lifediff.dev`. The self-run command is different: it keeps Google Calendar and Drive data on the machine that runs it, and hosted Life Diff does not use Google at all.

## What is stored

For a person who installs the GitHub App and signs in:

- GitHub user id and login.
- The GitHub user-to-server access token and refresh token, encrypted with AES-GCM. The key is a Worker secret and is not stored next to the token.
- GitHub App installation ids and the account login GitHub returns with them.
- A session snapshot of repository metadata: branch names and commit ids, pull request and issue titles and labels, and later the commits, comments, and file paths that changed. File bodies and patches are not stored. A file change is recorded as a line count such as `+10 −2`.
- An action log of what an agent claimed it did (`log_action` or `POST /v1/sessions/:id/actions`). Life Diff does not run those tools.
- For a call Life Diff forwarded: the tool name, the arguments, and a short result. Values whose keys contain `token`, `password`, `secret`, `authorization`, `api_key`, `cookie`, `credential`, or `key` are replaced with `[redacted]` before they are stored, including nested keys. The result snippet is capped. The call sent to the upstream is not redacted.
- Receipt JSON and the HTML report, in object storage, plus counts and expiry in the database.
- A daily diff for each local calendar day, stored so `/roundup` and `get_daily_diff` can return it. The stored settings are the IANA time zone (default America/Chicago), the end-of-workday time (default 18:00), and whether GitHub repository changes are included.
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

An hourly job applies those limits and finalizes a daily diff after the person's local end of workday. Deleting a receipt, snapshot, or daily diff removes both the database row and the stored object.

## How to delete it

- On `https://lifediff.dev/settings`, **Clear my history** deletes sessions, receipts, and daily diffs. It leaves the GitHub sign-in and the registered upstream servers. An agent can call `clear_my_history` with `confirm: true` for the same thing.
- In a browser, after GitHub has sent you back to Life Diff, open `https://lifediff.dev/account` and use **Delete my Life Diff data**. That form posts to `/account/delete` with a CSRF token. That deletes the account, including the GitHub sign-in, upstreams, settings, and history.
- An agent with a Life Diff token can call `DELETE https://lifediff.dev/v1/me`.

Deletion removes the user row, the encrypted GitHub token, installation ids, sessions, the action log, snapshots, receipts, and Life Diff MCP grants. It does not change GitHub. Uninstall the Life Diff GitHub App from GitHub settings separately. GitHub may keep its own copy of the authorization until that uninstall or a revoke on GitHub's side.

## Who can read it

The person who authorized the app, and MCP clients they approve, can read their receipts and log actions on their open session. Receipt HTML is served only with that person's Life Diff token. Tokens are checked against the resource `https://lifediff.dev/mcp`.
