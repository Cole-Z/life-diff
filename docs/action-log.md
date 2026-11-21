# Action log

Life Diff records tool calls that an agent routes through it. A call Life Diff forwarded is **Sent to that service, not verified**. A change the agent only described with `log_action` is **Agent says it did this, not verified**. Neither one means the account changed, and neither one means the tool did what the agent intended. The sentence a person sees names the object and the service. It does not include the raw tool name.

Where a service exposes its own history, Life Diff can also read that history. Today that check is GitHub. Those lines are **Verified in GitHub**. Provider diffs stay the source of truth for that service. The action log is the list of calls the proxy saw.

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

Redaction replaces values whose keys contain `token`, `secret`, `password`, `authorization`, `api_key`, `cookie`, `credential`, or `key` with `[redacted]`, including nested objects. The match ignores case. It also replaces secret values written inside ordinary text, before anything is saved: `api_key=...` or `password: ...` style pairs, `Bearer` tokens, and well-known token shapes (`ghp_`, `gho_`, `ghs_`, `github_pat_`, `sk_live_`, `sk_test_`, `rk_`, Slack `xox` tokens, `AKIA`, `AIza`, JWTs, and private-key blocks). The original key, separator, and scheme stay: `password: secret` becomes `password: [redacted]`, `password=secret` becomes `password=[redacted]`, and `Authorization: Bearer …` becomes `Authorization: Bearer [redacted]`. Claim targets, details, before/after text, and summaries are scanned too. A stored result is redacted the same way and then cut to 240 characters. The forwarded call still receives the original arguments. The receipt does not. Markdown, HTML, the card, and JSON are scanned again when they are returned.

Classification looks at words in the tool name. `delete`, `remove`, `send`, `share`, `unshare`, `revoke`, and `trash` are red writes. `create`, `add`, and `insert` are green. `update`, `move`, `write`, `post`, `edit`, `patch`, and `set` are amber. `ask`, `read`, `get`, `describe`, `lookup`, `check`, `list`, `search`, `fetch`, and `query` are gray reads. A write word wins over a read word. Anything else is unknown. The sentence uses the most human argument it can find, in this order: question, title, subject, name, query, then one nested level of the same. A repository name is not used when a question is present. A failed call is red, including when the tool name looks like a read, and the line says **Failed in that service** plus a short reason when there is one. It does not add a "Sent to" badge. The structured `trust` on that line is `Failed in that service` too. A reason that starts with `Error:` or `Error -` drops that label. `Error processing question: …` is left as written. The headline counts failures apart from changes that need a look: `1 change needs a look · 1 failed`, `3 changes, 1 needs a look · 2 failed`, and `1 failed call` when a failure is the only news. The same line is used for a session and a day. A result with `isError: true`, or text that is an error payload, is stored as a failure even when the transport succeeded. A failed attempt followed by a successful retry of the same call is one line.

A GitHub issue or pull request is closed only when the later read says its state is closed or merged. A name that is absent from a later list is not reported as removed. `get_daily_diff` (and `get_roundup`, the same tool) returns the user's local calendar day across every session. Reads collapse to one count. That line stays short (`3 lookups`) when every lookup has the same source. When a day mixes a forwarded call with one the agent reported, each row names the source. `detail: true` lists every lookup. Lookups for one repository stay under one heading, in the order that repository first appeared, even when another repository's lookups came in between. If a card cannot fit every line, it ends with `+N more` so the count still matches. Lines that need a look come first: an unverified claim, a failure, then a delete, send, or permission change. Checked changes follow. The line says **Undo available** only when an undo path exists, and **Undo not available yet** otherwise. The short undo id is set only when a path exists. Life Diff does not run the undo. When a session or a day has no changes, claims, or failures, the chat text is one line (`Nothing changed · 2 lookups`) and no card is attached. The receipt is still saved.

An upstream failure is returned to the agent as an MCP tool error and is still recorded.

MCP clients cache `tools/list`. After `add_upstream` or `remove_upstream`, Life Diff sends `notifications/tools/list_changed` when the connection can carry it. Reconnect if the new tools do not appear.

`end_session` writes the receipt. `get_receipt` returns a link to `https://lifediff.dev/receipts/<id>`. The page groups calls by service, lists writes first, collapses reads, and keeps the GitHub diff when this session had a snapshot.

`log_action` records a change made outside Life Diff. Do not use it for a read, or for a tool already called through Life Diff. `action` is `added`, `removed`, `modified`, or `read`. Optional `before`, `after`, and `url` are the old value, the new value, and an https link. Life Diff does not run that tool. The service is taken from the tool name, so `google_calendar` is Google Calendar. A claim is compared with GitHub only when that service is GitHub and the session has a snapshot. Any other change stays on the receipt, with the badge **Agent says it did this, not verified**. A `read` is counted with the lookups. When that read matches a call Life Diff already forwarded in the same session (same service, same kind of action, and a target that lines up), it is folded into that call and marked corroborated instead of counted again. A stored receipt that logged the same read twice, once as the proxied call and once as a claim stored beside it, is counted once when the daily diff is read. `end_session` with no session id closes the open session. A proxied tool result includes that id. Show the receipt only when something changed.

## Local stdio proxy

```bash
lifediff proxy -- <command> [args]
```

This wraps one stdio MCP server. JSON-RPC lines are copied through untouched. Each `tools/call` request/response pair is appended to `~/.lifediff/actions/<session>.jsonl`, mode `0600`. Stored arguments, results, and errors are redacted by secret-looking key names and by the same value patterns as the hosted receipt (`password: …`, `password=…`, `Bearer` tokens, `ghp_` / `gho_` / `ghs_` / `github_pat_`, `sk_live_` / `sk_test_` / `rk_`, Slack `xox` tokens, `AKIA`, `AIza`, JWTs, and private-key blocks). The key, separator, and `Bearer` scheme are kept. The directory is mode `0700`. `LIFEDIFF_HOME` overrides the directory, same as the rest of the command.

`lifediff receipt` prints the log in the terminal and writes HTML beside it. The colors match the hosted receipt. If a Google (or other provider) receipt is also saved, both are shown.

The earlier design of one process that launched several upstream commands from `~/.lifediff/proxy.json` is not what shipped. The local command wraps a single child process. Several upstreams belong on the hosted server, each as its own URL.

## Limits

- The proxy only sees calls the agent sends through Life Diff. A direct call to GitHub, Slack, or another MCP server is invisible.
- A successful tool result is not proof the side effect landed. The receipt says so.
- Verified diffs exist only for services that expose history Life Diff knows how to read. That is GitHub on the hosted service, and Calendar, Drive, and Gmail metadata in the self-run command.
- Upstream tool schemas are whatever the upstream returns. A server that is not streamable HTTP, or that needs a browser login instead of a static token, cannot be registered.
- Life Diff does not retry, rewrite, or block a forwarded call. If the action log cannot be written, the agent still gets the upstream result.
- The hosted tool list is cached briefly in the Worker isolate. Reconnect after adding an upstream if the client does not show the new names.
