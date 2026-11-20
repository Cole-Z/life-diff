# Life Diff

One receipt of everything your agent did, on any tool.

Life Diff records each tool call an agent makes through it and shows them on one receipt. Created is green, changed is amber, deleted or sent is red, and a lookup is gray. A line marked **reported by the proxy** is a call Life Diff forwarded. A line marked **verified from service history** was read from the service. GitHub is the history Life Diff checks on [lifediff.dev](https://lifediff.dev). Google Calendar, Drive, and Gmail stay in the local command.

The proxy only sees calls that go through it. A tool the agent calls some other way is not on the receipt. A verified line exists only where that service exposes history.

## Quickstart

### Hosted

Add this URL to the agent:

```text
https://lifediff.dev/mcp
```

Cursor, Claude, and other clients that accept a remote MCP server can use that address. The first connection asks you to sign in with GitHub. Life Diff keeps the GitHub token. The agent receives a Life Diff token.

Then register the other MCP servers the agent should use. After sign-in, open [https://lifediff.dev/settings](https://lifediff.dev/settings) and add a name, an https URL, and a token only when that server requires one. The same three fields are the tools `add_upstream`, `list_upstreams`, and `remove_upstream`. The token is stored encrypted and is not shown again.

A public server that needs no token, checked against the live endpoint:

| Name | URL |
| --- | --- |
| `docs` | `https://docs.mcp.cloudflare.com/mcp` |

Its tools are exposed as `docs__search_cloudflare_documentation` and `docs__migrate_pages_to_workers_guide`. Ask the agent to use them. The first forwarded call opens a session when none is open. While that session is open, [https://lifediff.dev/session](https://lifediff.dev/session) is the receipt. `end_session` stores it and, when the GitHub App can read the repositories, adds the GitHub diff on the same page.

`start_session`, `log_action`, `end_session`, `get_receipt`, and `list_receipts` still work. `start_session` before the other work is what makes the GitHub half a before-and-after check. If a recording session is already open, `start_session` attaches the GitHub snapshot and keeps the calls already recorded.

### On this computer

`lifediff proxy` wraps one stdio MCP server. JSON-RPC passes through unchanged. Each `tools/call` is appended to `~/.lifediff/actions/<session>.jsonl`.

Claude Desktop or Cursor:

```json
{
  "mcpServers": {
    "docs": {
      "command": "lifediff",
      "args": ["proxy", "--name", "docs", "--", "npx", "-y", "some-mcp-server"]
    }
  }
}
```

Use the absolute path to `lifediff` if it is not on `PATH`. Then:

```bash
lifediff receipt
```

That prints the calls and writes HTML in the same colors. With no Google receipt yet, `lifediff receipt --html report.html` writes that file. Arguments whose names look like a token, secret, password, authorization value, or key are stored as `[redacted]`.

## Limits

- A call is recorded only when the agent sends it through Life Diff.
- Read and write are guessed from the tool name. `create`, `update`, `delete`, `send`, `add`, `remove`, `move`, `write`, `post`, `edit`, and `patch` are writes. `get`, `list`, `search`, `read`, and `fetch` are reads. Anything else is unknown.
- The hosted proxy speaks streamable HTTP. `lifediff proxy` is the stdio wrapper. Neither one runs a server that was not registered or named on the command line.
- Verified history on the hosted service is GitHub. Verified history in the local command is Google Calendar, Drive, and Gmail. Other services are proxy reports.
- Life Diff does not undo a call.

## Self-hosted Google receipt

The local command is read-only. **Google Calendar** and **Google Drive** are the first providers. `lifediff auth --access full` also reads Drive activity, exports Google Docs, Sheets, and Slides as text, downloads plain text files, and reads **Gmail** subject, recipients, labels, and snippet. It does not create, edit, delete, or send anything, and it does not request Gmail message bodies.

![Sample receipt](docs/sample-report.png)

The picture above is the sample report rendered from fixture data, not from a live account. The same page is checked in as [docs/sample-report.html](docs/sample-report.html).

## What you get

- **Added** in green, **Removed** in red, **Modified** in amber, each with an icon and a label.
- A plain-language sentence, such as `Moved "Dentist" from Tue, Apr 7, 3:00 PM to Wed, Apr 8, 10:00 AM.`
- Field-level before and after values.
- Optional claim checking: each claim is **verified** or **missing**, and each real change the agent did not mention is **not claimed**.
- A confidence level from the session window. High means the service dates the change between the snapshot and the check. Low means the service dates it earlier, so it may be an older edit.

The services do not keep the history this needs, so Life Diff stores the snapshot on your computer. A Calendar sync token, the Drive Changes API, and (with full access) Gmail history are used when Google provides them. If a cursor expires, Life Diff reads the window or the list again and says so on the receipt.

A new service is a provider. It implements one interface and is registered on the engine. Calendar, Drive, and Gmail do not have to be edited to add Slack, Notion, Linear, GitHub, or Microsoft 365. See [docs/providers.md](docs/providers.md).

## Install

After a release tag such as `v0.2.0` is published, this installs the binary and the agent skill without Go:

```bash
curl -fsSL https://raw.githubusercontent.com/Cole-Z/life-diff/main/install.sh | sh
```

The binary goes to `~/.local/bin/lifediff`. The skill goes to `~/.cursor/skills/life-diff/SKILL.md`. Put `~/.local/bin` on your `PATH`.

To build from source instead:

```bash
git clone https://github.com/Cole-Z/life-diff.git
cd life-diff
go build -o lifediff ./cmd/lifediff
```

Go 1.26 or newer. The core is the importable package `github.com/Cole-Z/life-diff` (Go package name `lifediff`). A hosted product can call `Engine` with its own `Provider` list.

## Create a Google OAuth client

You use your own desktop OAuth client. Leave the app in **Testing** and add your account as a test user. Google does not require verification for that client, because you are the only user and the client is not published. That is the only reason the scopes below work without a verification review. A client shared with other people, or moved to production, would have to go through Google's review. `drive.readonly`, `drive.activity.readonly`, and `gmail.readonly` are restricted scopes. Do not share the client file.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project, for example `Life Diff`.
2. **APIs & Services → Library**. Enable **Google Calendar API** and **Google Drive API**. For full access, also enable **Google Drive Activity API** and **Gmail API**.
3. **APIs & Services → OAuth consent screen**.
   - User type: **External** (or Internal, if this is a Workspace org you administer).
   - App name: `Life Diff`.
   - Add your Google account under **Test users**.
   - Add the scopes for the access level you will use. Names are from [Google's OAuth scope list](https://developers.google.com/identity/protocols/oauth2/scopes).
   - Leave the publishing status as **Testing**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Desktop app**.
   - Download the JSON.
5. Save it as `~/.lifediff/credentials.json` and restrict it to your user:

   ```bash
   mkdir -p ~/.lifediff
   chmod 700 ~/.lifediff
   install -m 600 ~/Downloads/client_secret_*.json ~/.lifediff/credentials.json
   ```

   Or set `LIFEDIFF_CREDENTIALS` to the file path. Do not commit this file. The repo ignores `credentials.json`, `token.json`, and `access.json`.

### Scopes

Default, `lifediff auth` (minimal):

| Scope | What Google calls it | What Life Diff does with it |
| --- | --- | --- |
| `https://www.googleapis.com/auth/calendar.readonly` | See and download any calendar you can access using your Calendar | Reads events. Does not edit them. |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | View metadata for files in your Drive | Reads names, folders, trash, size, checksum, and version. A content edit shows up as a new version. The words inside a Doc are not read. |

Full, `lifediff auth --access full`. These replace the minimal Drive scope. They are still read-only:

| Scope | What Google calls it | What Life Diff does with it |
| --- | --- | --- |
| `https://www.googleapis.com/auth/calendar.readonly` | See and download any calendar you can access using your Calendar | Same as minimal. |
| `https://www.googleapis.com/auth/drive.readonly` | View and download all your Drive files | Exports Docs and Slides as text, Sheets as CSV, and downloads plain text files so the receipt can quote what changed. Images and other binaries stay metadata. Nothing is uploaded. |
| `https://www.googleapis.com/auth/drive.activity.readonly` | View the activity record of files in your Drive | Uses the activity time and verb (edited, renamed, and so on) on the receipt. |
| `https://www.googleapis.com/auth/gmail.readonly` | View your email messages and settings | Lists mail sent, drafted, deleted, archived, or relabeled, with subject, recipients, and the short snippet. Calls use `format=metadata` only. `format=full` and `format=raw` are not requested, so the message body is not downloaded. |

`drive.readonly` can download any file. Full mode uses that only for text: Docs, Sheets, Slides, and plain text files, capped per file. `gmail.readonly` can read message bodies. Full mode does not ask for them. Switching from minimal to full means running `lifediff auth --access full` again so Google grants the new scopes.

While the app stays in Testing, Google expires refresh tokens after seven days. Run `lifediff auth` again when a command says the sign-in needs to be refreshed.

## Sign in

```bash
./lifediff auth
./lifediff auth --access full
```

Life Diff listens on `127.0.0.1` and prints a link. Open it, choose the test user, and allow the read-only scopes. The token is saved at `~/.lifediff/token.json` with mode `0600`. The access level is saved at `~/.lifediff/access.json`, also mode `0600`. The command prints the path and the scope list, not the token.

```bash
./lifediff auth --status
```

If Google reports `redirect_uri_mismatch`, the desktop client needs the loopback address. `lifediff auth` prints the exact redirect URL it is using (`http://127.0.0.1:<port>/callback`). Add that host as an authorized redirect URI on the OAuth client, or create the client again as a **Desktop app**, which accepts the loopback redirect.

## Check one agent session

```bash
./lifediff snapshot
# let the agent do its work
./lifediff diff --claims claims.json
```

`snapshot` stores Calendar events from 24 hours ago through 90 days ahead, plus Drive file metadata (`trashed = false`, up to 2000 files, newest changes first). With full access it also stores text for the newest 40 Docs, Sheets, Slides, and plain text files, and Gmail subject, recipients, labels, and snippet for the newest 100 messages from the last 30 days, plus the mailbox history id. Those files stay on this computer, mode `0600`. Narrow the snapshot with `--from`, `--to`, `--calendar`, `--tz`, `--only calendar,drive,gmail`, `--drive-query`, and `--max-files`. `--only all` is the default.

`diff` writes:

- `~/.lifediff/receipts/<id>.json` — the receipt ([schema](docs/receipt-schema.md))
- `~/.lifediff/receipts/<id>.html` — the report

Both are mode `0600`. `--json` and `--html` copy them somewhere else, also mode `0600`.

`--strict` exits with status 3 when a claim is missing, a change was not claimed, or you passed no claims and anything changed.

```bash
./lifediff receipt          # print the latest receipt again
./lifediff demo --html docs/sample-report.html --json docs/sample-receipt.json
```

### Claims file

```json
{
  "claims": [
    {"service": "calendar", "action": "modified", "target": "Dentist", "detail": "Moved to Wednesday at 10:00 AM"},
    {"service": "drive", "action": "created", "target": "Q2 goals"},
    {"service": "gmail", "action": "added", "target": "Hello"}
  ]
}
```

A bare array is also accepted. `action` may be `added`, `removed`, `modified`, or everyday synonyms such as `moved`, `renamed`, `created`, and `deleted`. `service` is a provider id (`calendar`, `drive`, `gmail`, or a later provider). Omit `--claims` and Life Diff only lists the changes; it does not mark them unclaimed.

## MCP server

`lifediff mcp` speaks MCP over stdin and stdout, using the official Go SDK (`github.com/modelcontextprotocol/go-sdk`). Run `lifediff auth` once first. The tools are `snapshot`, `diff`, and `get_receipt`. Logs stay off stdout so they do not break the protocol.

```json
{
  "mcpServers": {
    "lifediff": {
      "command": "/absolute/path/to/lifediff",
      "args": ["mcp"]
    }
  }
}
```

An agent skill that tells the agent when to snapshot, how to install without Go, and how to present the receipt is in [skills/life-diff/SKILL.md](skills/life-diff/SKILL.md).

`lifediff proxy` is the local pass-through. The hosted pass-through is `https://lifediff.dev/mcp`. Both are described in [docs/action-log.md](docs/action-log.md).

## Where data lives

| Path | What it is |
| --- | --- |
| `~/.lifediff/credentials.json` | Your OAuth client file. You create it. |
| `~/.lifediff/token.json` | Saved sign-in. Mode `0600`. |
| `~/.lifediff/access.json` | `minimal` or `full`, and the scope list. Mode `0600`. |
| `~/.lifediff/snapshots/` | Before-images, including event titles and file names. Mode `0600`. |
| `~/.lifediff/receipts/` | JSON receipts and HTML reports. Mode `0600`. |

Override the directory with `LIFEDIFF_HOME`. Life Diff creates it as mode `0700`. Nothing is sent anywhere except to Google's own APIs. Minimal access uses GET with the two read-only scopes. Full access also exports Drive text, POSTs a Drive Activity query (a filter, not a file body), and reads Gmail headers and snippets.

## Library

`Engine.TakeSnapshot` and `Engine.Compare` depend on the `Provider` interface, not on the desktop OAuth flow. Calendar and Drive adapt `CalendarReader` and `DriveReader`. Gmail implements `Provider` directly. `BuildReceipt` does not touch the network: it turns a snapshot and a later read into a receipt. The CLI, the local token store, and the MCP server are wrappers around that. [docs/providers.md](docs/providers.md) is the guide for a new service.

## Development

```bash
go vet ./...
go test ./...
```

Tests use fake Calendar, Drive, and Gmail responses. They do not call Google. GitHub Actions runs `go vet` and `go test` on push and pull request.

A tag named `v*` builds release binaries with GoReleaser: macOS arm64 and amd64, Linux arm64 and amd64, and Windows arm64 and amd64. The archive includes this README and `skills/life-diff/SKILL.md`. `install.sh` downloads that archive.

To regenerate the checked-in sample report:

```bash
go run ./cmd/lifediff demo --html docs/sample-report.html --json docs/sample-receipt.json
```

## License

[Apache License 2.0](LICENSE).
