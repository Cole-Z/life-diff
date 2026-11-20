# Action log

Life Diff records tool calls that an agent sends through it. A recorded call is **reported by the proxy**. It is not, by itself, proof that an account changed. Where a service exposes history, Life Diff still reads that history and labels the result **verified from service history**. GitHub is that check on the hosted service. Google Calendar, Drive, and Gmail are that check in the local command.

Two proxies are implemented.

## Hosted proxy

`https://lifediff.dev/mcp` is the MCP server. A signed-in user registers upstream streamable-HTTP MCP servers, on [https://lifediff.dev/settings](https://lifediff.dev/settings) or with the tools `add_upstream`, `list_upstreams`, and `remove_upstream`.

Each upstream is a name, an https URL, and an optional token. The token may be a bearer token or a single header such as `X-Api-Key: value`. It is encrypted with the same AES-GCM `TOKEN_ENCRYPTION_KEY` as the GitHub token and stored in D1. It is not returned by `list_upstreams`, not rendered on the settings page, and not written into the receipt.

`tools/list` on `/mcp` includes the five Life Diff tools, the three upstream tools, and every upstream tool under the name `<upstream>__<tool>`. `tools/call` on a namespaced tool is forwarded. The agent receives the upstream result, or a short error if the upstream fails. A redirect is not followed.

Every forwarded call is appended to the open session. If none is open, Life Diff opens a recording session. The stored fields are the time, upstream, tool, redacted arguments, a one-line summary, ok or error, duration, and a read/write class:

| Tool name contains | Class | Receipt color |
| --- | --- | --- |
| `create`, `add` | write | green |
| `update`, `move`, `write`, `post`, `edit`, `patch` | write | amber |
| `delete`, `remove`, `send` | write | red |
| `get`, `list`, `search`, `read`, `fetch` | read | gray |
| anything else | unknown | neutral |

The first matching write verb wins, so `get_or_create` is a write. Reads are collapsed on the receipt. Writes are listed first, grouped by upstream. Argument keys that split into `token`, `secret`, `password`, `authorization`, or `key` are stored as `[redacted]`.

`start_session` still snapshots GitHub. If the open session was only recording calls, `start_session` keeps those calls and attaches the snapshot. `end_session` diffs GitHub when a snapshot exists and writes one receipt that contains both the proxy lines and the GitHub lines. `log_action` is unchanged: it is still a claim the agent states, and it is still checked against GitHub. Forwarded calls are not turned into those claims.

The open session is also at `https://lifediff.dev/session` for the browser that signed in. A stored receipt at `/receipts/<id>` accepts that browser session or a Life Diff bearer token.

## Local stdio proxy

```bash
lifediff proxy [--name service] -- <command> [args]
```

The process speaks MCP on stdin and stdout. It starts `<command>` and copies each JSON-RPC message through without changing the bytes. `tools/call` responses are appended to `~/.lifediff/actions/<session>.jsonl` (mode `0600`). The directory is mode `0700`. `LIFEDIFF_HOME` overrides the directory, as it does for the rest of the local command.

`lifediff receipt` prints those lines and writes HTML with the same colors. It still prints a Google receipt when one exists.

Claude Desktop or Cursor:

```json
{
  "mcpServers": {
    "docs": {
      "command": "/absolute/path/to/lifediff",
      "args": ["proxy", "--name", "docs", "--", "npx", "-y", "some-mcp-server"]
    }
  }
}
```

The local proxy does not sign in to the upstream. The wrapped command keeps its own credentials. Life Diff does not put those credentials in the log. A failed log write is reported on stderr. Stdout stays the MCP stream.

## What a recorded line is not

- It is not proof the side effect landed. The tool can return success and the account can be unchanged. The GitHub or Google section is the check, and only for those services.
- It is missing when the agent called a server that was not registered, or was not the command behind `lifediff proxy`.
- It does not undo anything.
- The read/write color is a guess from the tool name. A tool named `search` that writes would be shown in gray.

## Receipt field

Hosted receipts stay schema `1.0.0`. They add an `actions` array. Readers that do not know the field ignore it.

```json
{
  "actions": [
    {
      "id": "act_1",
      "time": "2026-04-02T15:12:00Z",
      "upstream": "docs",
      "tool": "search_cloudflare_documentation",
      "arguments": { "query": "Durable Objects" },
      "ok": true,
      "summary": "Looked up \"Durable Objects\" in Docs.",
      "durationMs": 180,
      "effect": "read",
      "tone": "read",
      "source": "proxy",
      "resultSummary": "A Durable Object keeps state."
    }
  ]
}
```

`source` is `proxy`. That is not `verified`, `missing`, or `unclaimed`. Those three stay on GitHub changes and on claims from `log_action`.
