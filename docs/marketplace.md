# Marketplace listing checklist

This file is the checklist for listing Life Diff in a public MCP directory. Nothing here publishes the server. Cole publishes it himself, after he merges and deploys.

The registry metadata is `server.json` at the repository root. It follows the MCP Registry server schema (`2025-12-11`). The name is `io.github.Cole-Z/life-diff`. The remote is `https://lifediff.dev/mcp`. The description is under 100 characters.

Before a listing:

- Confirm `https://lifediff.dev/mcp` answers `initialize` and the `instructions` field tells a client to route tool calls through Life Diff, call `end_session` when a piece of work is finished, and call `get_daily_diff` at the end of the day.
- Confirm the tool list is `start_session`, `end_session`, `get_daily_diff`, `get_roundup`, `get_receipt`, `list_receipts`, `log_action`, `add_upstream`, `list_upstreams`, `remove_upstream`, and `clear_my_history`, plus `<upstream>__<tool>` after an upstream is added.
- Confirm sign-in is GitHub, and that a session with no named repositories does not read repository history.
- Confirm `clear_my_history` does nothing unless `confirm` is true.
- Point the directory at `https://lifediff.dev` and the privacy draft in `PRIVACY.md`.
- Do not submit the registry entry from CI or from a pull request.
