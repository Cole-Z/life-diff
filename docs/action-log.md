# Action log

Life Diff records tool calls that an agent routes through it. A recorded call is **reported by proxy**. It means Life Diff saw the request and the response. It does not mean the account changed, and it does not mean the tool did what the agent intended.

Where a service exposes its own history, Life Diff can also read that history. Today that check is GitHub. Those lines are **verified from service history**. Provider diffs stay the source of truth for that service. The action log is the list of calls the proxy saw.

## Hosted proxy

A signed-in user registers upstream MCP servers, either on `https://lifediff.dev/settings` or with the MCP tools `add_upstream`, `list_upstreams`, and `remove_upstream`.

Each upstream is a streamable HTTP URL plus an optional bearer token or static header. The secret is encrypted with `TOKEN_ENCRYPTION_KEY` (AES-GCM, the same pattern as the GitHub token) and stored in D1. It is not written to logs and it is not returned by `list_upstreams` or the settings page.

`https://lifediff.dev/mcp` keeps the existing tools (`start_session`, `log_action`, `end_session`, `get_receipt`, `list_receipts`) and also exposes every upstream tool as `<upstream>__<tool>`. `tools/list` and `tools/call` are forwarded. Life Diff starts an MCP session with the upstream (`initialize`, `notifications/initialized`, and the `mcp-session-id` header) and accepts either a JSON body or an SSE `event: message` body.

Every forwarded `tools/call` is appended to the user's open session. If none is open, Life Diff opens one. A session opened this way has no GitHub snapshot. `start_session` reads GitHub only for repositories passed in `repos`. A later `start_session` with a different list closes the previous session instead of keeping the wider one.

A recorded call stores:

| Field | Meaning |
| --- | --- |
| time | When the response came back. |
| upstream | Registered name. |
| tool | Upstream tool name, not the namespaced name. |
| arguments | Arguments after redaction. |
| status | `ok` or `error`. |
| summary | One plain-language sentence. |
| effect | `read`, `write`, or `unknown`. |
| tone | `created`, `changed`, `removed`, `read`, or `unknown`. Used for the color. |
| duration | Milliseconds spent waiting on the upstream. |
| error | Present when the call failed. |
| result | A short slice of the text result. |

Redaction replaces values whose keys contain `token`, `secret`, `password`, `authorization`, `key`, or `cookie` with `[redacted]`. The forwarded call still receives the original arguments. The receipt does not.

Classification looks at words in the tool name. `delete`, `remove`, and `send` are red writes. `create`, `add`, and `insert` are green. `update`, `move`, `write`, `post`, `edit`, `patch`, and `set` are amber. `ask`, `read`, `get`, `describe`, `lookup`, `check`, `list`, `search`, `fetch`, and `query` are gray reads. A write word wins over a read word. Anything else is unknown. The sentence uses the most human argument it can find, in this order: question, title, subject, name, query, then one nested level of the same. A repository name is not used when a question is present. A failed call is a warning, including when the tool name looks like a read. A failed attempt followed by a successful retry of the same call is one line.

A GitHub issue or pull request is closed only when the later read says its state is closed or merged. A name that is absent from a later list is not reported as removed. `get_daily_diff` (and `get_roundup`, the same tool) returns the user's local calendar day across every session. Reads collapse to one count. An undo hint and its short id appear only when there is a real undo. Life Diff does not run the undo.

An upstream failure is returned to the agent as an MCP tool error and is still recorded.

MCP clients cache `tools/list`. After `add_upstream` or `remove_upstream`, Life Diff sends `notifications/tools/list_changed` when the connection can carry it. Reconnect if the new tools do not appear.

`end_session` writes the receipt. `get_receipt` returns a link to `https://lifediff.dev/receipts/<id>`. The page groups calls by service, lists writes first, collapses reads, and keeps the GitHub diff when this session had a snapshot.

`log_action` still records a claim the agent states in its own words. Life Diff does not run that tool. On a session that snapshotted GitHub, the claim is checked against the diff. On a proxy-only session it is kept and marked not verified, because there was nothing to compare.

## Local stdio proxy

```bash
lifediff proxy -- <command> [args]
```

This wraps one stdio MCP server. JSON-RPC lines are copied through untouched. Each `tools/call` request/response pair is appended to `~/.lifediff/actions/<session>.jsonl`, mode `0600`. The directory is mode `0700`. `LIFEDIFF_HOME` overrides the directory, same as the rest of the command.

`lifediff receipt` prints the log in the terminal and writes HTML beside it. The colors match the hosted receipt. If a Google (or other provider) receipt is also saved, both are shown.

The earlier design of one process that launched several upstream commands from `~/.lifediff/proxy.json` is not what shipped. The local command wraps a single child process. Several upstreams belong on the hosted server, each as its own URL.

## Limits

- The proxy only sees calls the agent sends through Life Diff. A direct call to GitHub, Slack, or another MCP server is invisible.
- A successful tool result is not proof the side effect landed. The receipt says so.
- Verified diffs exist only for services that expose history Life Diff knows how to read. That is GitHub on the hosted service, and Calendar, Drive, and Gmail metadata in the self-run command.
- Upstream tool schemas are whatever the upstream returns. A server that is not streamable HTTP, or that needs a browser login instead of a static token, cannot be registered.
- Life Diff does not retry, rewrite, or block a forwarded call. If the action log cannot be written, the agent still gets the upstream result.
- The hosted tool list is cached briefly in the Worker isolate. Reconnect after adding an upstream if the client does not show the new names.
