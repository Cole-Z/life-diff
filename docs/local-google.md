# Local Google snapshots

Build the CLI from source using the [local install steps](local-proxy.md#build-from-source). The local CLI compares Google Calendar and Drive with a snapshot taken before the agent ran. Full access also reads Drive activity, capped exports of supported text files, and Gmail metadata and snippets. All Google scopes are read-only. [Open the synthetic local report.](sample-report.html)

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

- `~/.lifediff/receipts/<id>.json` — the receipt ([schema](receipt-schema.md))
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

## Local MCP setup

Run `./lifediff auth` once, then merge this entry with the existing configuration of a stdio-capable client. The tools are `snapshot`, `diff`, and `get_receipt`.

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

## Local data

The CLI defaults to `~/.lifediff`. Set `LIFEDIFF_HOME` to use a different directory. Life Diff creates its data directory with mode `0700` and writes tokens, access settings, snapshots, and receipts with mode `0600`. Snapshots and receipts may contain event titles, file names, and, at full access, document text and mail snippets. The Google snapshot workflow calls Google's APIs and keeps its artifacts on the machine running the CLI. To remove them, delete the relevant files from that directory and revoke Google authorization in your Google account if desired.
