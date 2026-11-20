# Action log: `lifediff mcp-proxy`

This is a design. `lifediff mcp-proxy` is not implemented. The command does not exist yet. The receipt schema does not have an `actions` array yet.

## Why

Life Diff reads the accounts themselves. That is the record of what changed. It does not know which agent tool call asked for the change. An agent can say it updated a doc, and the receipt can show the doc changed, without a link between the two.

A pass-through MCP proxy can record the tool calls the agent made during the session and attach them to the receipt as **claimed** actions. Claimed means "the agent invoked this tool." It does not mean the account changed, and it does not mean the tool call succeeded at doing what the agent intended. Provider diffs stay the source of truth. The action log is a second list next to them.

## Command

```bash
lifediff mcp-proxy --config ~/.lifediff/proxy.json
```

The process speaks MCP on stdin and stdout, the same way `lifediff mcp` does. The agent is configured to talk to `lifediff mcp-proxy` instead of talking to each upstream server directly. The proxy forwards every message to the upstream servers named in the config and forwards their responses back. It does not add tools of its own except an optional `lifediff_actions` read that returns the log for the current process.

```json
{
  "session": "auto",
  "upstreams": [
    {
      "name": "drive",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-gdrive"]
    },
    {
      "name": "calendar",
      "command": "calendar-mcp"
    }
  ]
}
```

`session` `auto` uses the latest Life Diff snapshot id if one exists, otherwise an id created at proxy start. The log file is `~/.lifediff/actions/<session>.jsonl`, mode `0600`. The directory is mode `0700`. Override the directory with `LIFEDIFF_HOME`, same as the rest of Life Diff.

The proxy does not sign in to Google and does not widen scopes. Upstream servers keep their own credentials. Life Diff still uses the read-only token from `lifediff auth`.

## What is logged

For each MCP `tools/call` request the proxy appends one JSON line after the upstream responds:

| Field | Meaning |
| --- | --- |
| `time` | RFC3339 time the response came back. |
| `upstream` | Name from the config. |
| `tool` | Tool name. |
| `arguments` | Arguments after redaction. |
| `ok` | `true` when the upstream result is not an error. |
| `status` | Always `claimed` in this design. |
| `summary` | One short sentence, such as `drive.create_file "Q2 goals"`. |

Redaction runs before the line is written. Strip values whose keys look like tokens, secrets, passwords, authorization headers, cookies, or refresh tokens. Replace them with `[redacted]`. Do not write the upstream process environment. Do not write file bodies; if an argument is longer than a few kilobytes, store its length and a hash prefix instead of the text.

The proxy does not block the call, rewrite the arguments, or retry. If the log write fails, the proxy still returns the upstream result and prints a single warning on its own log, not on stdout. Stdout is the MCP stream.

Initialize, list-tools, and cancelled calls can be logged at debug level. They are not claimed actions. Only `tools/call` becomes a claimed action.

## How it meets the receipt

`lifediff diff` gains an optional `--actions <session>` flag, defaulting to the action log whose session id matches the snapshot. When that file exists, the receipt includes:

```json
{
  "actions": [
    {
      "id": "act_1",
      "time": "2026-04-02T15:12:00Z",
      "upstream": "drive",
      "tool": "create_file",
      "summary": "drive.create_file \"Q2 goals\"",
      "status": "claimed",
      "ok": true
    }
  ]
}
```

`status` is `claimed`. That word is not `verified`, `missing`, or `unclaimed`. Those three stay on provider changes and on the claims file. A claimed action is the agent saying, through a tool call, that it tried something.

The HTML report gets a section, "Claimed actions", under the provider sections. Each row is the summary, the time, and whether the tool result was an error. The section intro says these lines are tool calls, not account changes.

A later version can match an action to a provider change (for example a Drive `create_file` whose argument equals a new file name) and set a `matchedChangeIds` field. This design does not do that matching. Until it exists, the report must not describe a claimed action as verified.

`lifediff diff --claims` is unchanged. The claims file is still what the agent says in its own words. The action log is what the proxy saw. Both can be present. Neither replaces the provider diff.

## Failure and trust

- The proxy is local. It does not send the log anywhere.
- A missing upstream is an error to the agent, not a silent skip.
- The log is not proof that the tool's side effect landed. A tool can return success and the account can be unchanged. The receipt already shows that case: the action is claimed, and the provider section has no matching change.
- An agent that talks to an upstream directly, bypassing the proxy, produces no claimed action. The provider diff still runs.
- Undo stays out of this design. The proxy does not add a write path.

## Not in this change

No `mcp-proxy` subcommand, no JSONL writer, no receipt field, no report section. The next implementation should add those behind the same read-only rules: local files mode `0600`, redaction tests, and a fake upstream MCP server instead of a live one.
