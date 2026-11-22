# Connect your client to Life Diff

Add `https://lifediff.dev/mcp` as a remote **Streamable HTTP** MCP server named `lifediff`. Use your client's OAuth flow and sign in with GitHub. Life Diff requires `receipts:read` and `sessions:write` for MCP. GitHub repository checks have a [separate opt-in](github-checks.md).

The snippets are complete minimal files. When a file already exists, add the `lifediff` entry under its existing server table or object and keep the other entries. Use the browser sign-in flow for credentials.

- [Codex CLI](#codex-cli) · [Codex VS Code extension](#codex-vs-code-extension)
- [Claude Code](#claude-code) · [Claude web and Desktop](#claude-web-and-desktop)
- [GitHub Copilot in VS Code](#github-copilot-in-vs-code) · [GitHub Copilot CLI](#github-copilot-cli)
- [Cursor](#cursor) · [Gemini CLI](#gemini-cli) · [ChatGPT web](#chatgpt-web) · [MCP Inspector](#mcp-inspector)
- [First lookup](#first-lookup) · [Troubleshooting](#troubleshooting) · [Verification status](#verification-status)

## Codex CLI

Add the server on the host running Codex. Follow the browser prompt. If setup stops before sign-in completes, run the login command. Start a fresh Codex session after changes. `codex mcp list` checks configuration and interactive `/mcp` shows discovered tools.

```sh
codex mcp add lifediff --url https://lifediff.dev/mcp
# Run if sign-in is still needed
codex mcp login lifediff
codex mcp list
```

If the client requests fewer permissions, run `codex mcp login lifediff --scopes receipts:read,sessions:write`. On a headless host use `--no-browser` with the login command and follow Codex's callback instructions. Treat authorization and callback URLs as private. If client identity metadata cannot be loaded, retry the login with `--oauth-client-registration dcr` on versions that support it. [Codex MCP documentation](https://developers.openai.com/codex/mcp)

## Codex VS Code extension

In the extension gear menu, choose **MCP servers → Add server → Streamable HTTP**. Save the endpoint, choose **Restart extension**, and use **Authenticate** if prompted. Open a fresh Codex session and confirm Life Diff's tool list.

The CLI and extension share configuration when they use the same Codex host. For WSL or SSH, edit the configuration and authenticate on the host running Codex, then check discovery in that remote session. As a fallback, add this table to that host's `~/.codex/config.toml` or trusted project `.codex/config.toml`.

```toml
[mcp_servers.lifediff]
url = "https://lifediff.dev/mcp"
```

[Codex extension MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=ide)

## Claude Code

Add the server in user scope on the Claude Code host. Open Claude Code and use `/mcp` to select Life Diff and complete OAuth. Reconnect the server from `/mcp` or reopen the session after a catalog change. Check that menu for the discovered tools.

```sh
claude mcp add --transport http --scope user lifediff https://lifediff.dev/mcp
```

For a project-scoped setup, merge this into the workspace root's `.mcp.json` and approve the project server when Claude Code prompts.

```json
{
  "mcpServers": {
    "lifediff": {
      "type": "http",
      "url": "https://lifediff.dev/mcp"
    }
  }
}
```

[Claude Code MCP setup](https://code.claude.com/docs/en/mcp)

## Claude web and Desktop

Open **Customize → Connectors → Add custom connector**. Enter the endpoint, choose **Sign in now** or **Sign in when needed**, and follow Life Diff's GitHub flow. Use Claude's published identity if offered, or automatic OAuth registration. Team and Enterprise may require an owner or another authorized role.

Enable the connector in a conversation. After adding an upstream, reconnect or start a fresh conversation to check for its namespaced tool. Call `list_upstreams` to confirm the enabled connector can act for your account. Claude Desktop's [local stdio setup](local-proxy.md) is a separate workflow. [Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

## GitHub Copilot in VS Code

Use a current VS Code and Copilot build. Check the session target in Chat so you configure the active harness. Run **MCP: Add Server**, select **HTTP**, and supply the endpoint. Approve workspace and server trust prompts if permitted. Follow the OAuth prompt, start or restart the server in the active session, then confirm Life Diff in the agent's tool picker.

For the **Copilot harness**, choose **Global → Copilot Global**. The native user file is `~/.copilot/mcp-config.json` on the harness host, or `mcp-config.json` under `COPILOT_HOME`. A workspace-root `.mcp.json` is the native project option when supported. Merge this entry under `mcpServers`.

```json
{
  "mcpServers": {
    "lifediff": {
      "type": "http",
      "url": "https://lifediff.dev/mcp",
      "tools": ["*"]
    }
  }
}
```

For the editor-managed **Local** surface where it is still active, use the profile `mcp.json` or workspace `.vscode/mcp.json`. This surface uses `servers` and its own start and restart controls.

```json
{
  "servers": {
    "lifediff": {
      "type": "http",
      "url": "https://lifediff.dev/mcp"
    }
  }
}
```

[VS Code MCP setup](https://code.visualstudio.com/docs/agent-customization/mcp-servers) · [Native and editor-managed configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)

## GitHub Copilot CLI

In the interactive CLI, run `/mcp add`. In the form, select the remote **HTTP** type, set name `lifediff`, enter `https://lifediff.dev/mcp`, and save with the form's controls. The user configuration is `~/.copilot/mcp-config.json` by default. Use `/mcp auth lifediff` for sign-in or refresh. Reload with `/mcp reload` or reopen the CLI, then inspect `/mcp list` and `/mcp show lifediff`.

```sh
copilot mcp add --transport http lifediff https://lifediff.dev/mcp
```

[Copilot CLI MCP setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) · [Command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)

## Cursor

Merge the entry into `~/.cursor/mcp.json` or the project's `.cursor/mcp.json`. Find Life Diff in Cursor's MCP settings and follow the OAuth prompt. Refresh the tool catalog or restart the MCP connection, then inspect the listed tools and run the lookup.

```json
{
  "mcpServers": {
    "lifediff": {
      "url": "https://lifediff.dev/mcp"
    }
  }
}
```

[Cursor MCP documentation](https://cursor.com/docs/mcp)

## Gemini CLI

Merge the entry into `~/.gemini/settings.json`. The `httpUrl` field selects Streamable HTTP. In Gemini CLI use `/mcp auth lifediff` for sign-in, then `/mcp refresh` after a catalog change. Use `/mcp list` to see the tools.

```json
{
  "mcpServers": {
    "lifediff": {
      "httpUrl": "https://lifediff.dev/mcp"
    }
  }
}
```

[Gemini CLI MCP setup](https://geminicli.com/docs/tools/mcp-server/) · [Commands](https://geminicli.com/docs/reference/commands/)

## ChatGPT web

In an eligible Business or Enterprise/Edu web workspace where you have permission to add custom MCP servers, use **Plugins → + → Add custom MCP server**. Name it Life Diff, enter `https://lifediff.dev/mcp`, and choose **OAuth**. Where offered, use Client ID Metadata Documents (CIMD) for registration. Follow the approved GitHub flow, scan and review tools, then install and enable the plugin in a test conversation. Use the plugin details page to refresh after registering an upstream and check whether the namespaced tool appears. `Apps → Create` applies to workspaces still using the legacy custom app interface.

For a personal-plan setup, use [Codex CLI](#codex-cli), [Claude Code](#claude-code), or [MCP Inspector](#mcp-inspector). [ChatGPT custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server) · [Workspace access](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) · [OAuth](https://developers.openai.com/plugins/build/auth)

## MCP Inspector

Launch the Inspector locally. Select **Streamable HTTP**, enter the endpoint, and complete the browser flow in its OAuth UI. Confirm initialization and both scopes. Use **Tools → List Tools**, reconnect after a catalog change, then use **Call Tool** to run each smoke-test step. For receipt results, inspect the raw content and structured data before comparing image and Markdown presentation.

```sh
npx @modelcontextprotocol/inspector --server-url https://lifediff.dev/mcp --transport http
```

[MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)

## Other clients

Use a remote Streamable HTTP configuration on the active host and a client that supports MCP OAuth discovery and the GitHub-backed browser flow. Reconnect after adding an upstream. Verify authenticated tool discovery, one routed call, the resulting receipt, and catalog refresh before relying on the setup.

## First lookup

An **upstream** is a tool server whose calls you want routed through Life Diff. [DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki-mcp) is public and needs no token. Start with a fresh Life Diff session. Check for any existing shared open session before closing or running the test.

Paste the first block into your agent, then refresh or reconnect the client before pasting the second.

```text
Use Life Diff's list_upstreams to confirm sign-in and show saved upstreams.
If there is no upstream named deepwiki, use Life Diff's add_upstream with
{"name":"deepwiki","url":"https://mcp.deepwiki.com/mcp"}. Use no token.
If deepwiki already exists, confirm it points to that URL and reuse it.
Stop after reporting whether it is registered.
```

Find `deepwiki__read_wiki_structure` in Life Diff's catalog before proceeding.

```text
On a clean Life Diff session, call Life Diff's deepwiki__read_wiki_structure once
with {"repoName":"facebook/react"}. Use that exact namespaced tool.
Report any upstream or capture error. If the call is recorded, use end_session
with the session ID from the call. Then use get_receipt with the returned
receipt ID and show the receipt Markdown, even if you can also show the image.
```

Expect a DeepWiki result, one lookup, zero writes, and no image in the immediate `end_session` response. The lookup receipt is saved. `get_receipt` can return its card and has text for clients that ignore MCP images. Its signed HTML link is private. `get_daily_diff` aggregates the whole local day, so previous runs can affect totals. [See a synthetic change receipt.](https://lifediff.dev/sample-receipt)

## Troubleshooting

- **Sign-in canceled, expired, or insufficient scope.** Start a new client sign-in and complete GitHub and Life Diff consent with both scopes. Reopen the client session. For Settings and Today, use the browser profile that completed sign-in.
- **Registration succeeds but tools are missing.** `list_upstreams` confirms registration. Discovery happens when Life Diff builds the tool catalog. Reconnect or rescan from the active client, then look for the namespaced name. If credentials or the endpoint changed, remove the old registration and add it again. If the upstream is slow or temporarily unavailable, allow at least 10 seconds for a failed discovery cache entry to expire and reconnect again. A successful catalog can be cached on the server for up to a minute. The client can cache it separately. Check that the upstream actually exposes tools at the configured HTTPS URL.
- **An upstream or capture error occurs.** The upstream result and Life Diff's capture result describe different steps. If Life Diff says the call could not be recorded, check the upstream state before taking any further action that could repeat a write.
- **The client skips the image.** Use the receipt Markdown or open the signed HTML link privately. A lookup-only close normally returns a single text line. Fetch it with `get_receipt` for the card.

## Beta behavior

- **Session boundary.** Each GitHub account has one open session across its clients. The first routed call that finishes and is captured can start a session. A call completing after a close may go into the next session, or report a capture failure if it races the close. Use the session marker to see where it was recorded. Recorded client names appear where available. Close explicitly with the session ID for an immediate receipt. A retry by session ID can return the same saved receipt within a day.
- **Idle timing.** The default is 20 minutes since the last recorded activity, adjustable from 5 to 180. An idle session is eligible to close when the next session-opening activity happens or when the hourly sweep runs at minute 05. The threshold sets eligibility. Reading the current daily roundup can show an open session in progress. The workday sweep can also seal a session when finalizing a due roundup.
- **Relay compatibility.** The hosted beta relays text blocks, object-valued structured results, and upstream MCP error flags. Upstream image, audio, and resource blocks are omitted with a notice. Life Diff's own receipt cards can be sent as MCP images. A tool result records what the upstream reported. Independent corroboration is available for supported changes on opted-in GitHub repositories.
- **Undo.** Life Diff generates a prompt to review. After you approve it, an agent with permission can execute the reversal. An undo request and an observed reversal are separate events.

## Verification status

Updated November 22, 2026. **Documented by vendor** means the setup path is published by the client vendor. End-to-end verification requires GitHub sign-in, discovery, the routed lookup and a saved receipt on that surface.

| Surface | Status |
| --- | --- |
| Codex CLI | 0.171.0. Reached the hosted consent page through automatic CIMD. Local DCR reached consent and handled a denied callback. Hosted GitHub callback, tool discovery, refresh, and rendering require an authorized test account. |
| Claude Code | 2.1.330. Added the HTTPS endpoint in a disposable client profile. `claude mcp list` reported **Needs authentication**. OAuth completion, tool discovery, refresh, and rendering require an authorized test account. |
| Codex VS Code extension | Documented by OpenAI. VS Code extension and WSL/SSH paths untested here. |
| Claude web and Desktop | Documented by Anthropic. Connector OAuth, refresh, and rendering untested here. |
| GitHub Copilot in VS Code | Native Copilot and editor-managed Local configurations documented by Microsoft. Runtime target, discovery, refresh, and rendering untested here. |
| GitHub Copilot CLI | Documented by GitHub. Interactive OAuth and discovery untested here. |
| Cursor | Documented by Cursor. Desktop 3.31.15 was present. OAuth, discovery, refresh, and rendering untested here. |
| Gemini CLI | Documented by Google. CLI OAuth, refresh, and rendering untested here. |
| ChatGPT web | Blocked. No authorized eligible workspace for OAuth redirect, tool scan, catalog refresh, or rendering. |
| MCP Inspector | 2.16.0. Hosted CLI tool-list attempt returned `auth_required` while signed out. OAuth UI, authenticated discovery, refresh, and rendering remain unverified. |
| Other clients | Unverified. |

For an authenticated verification run, use a disposable account. Record the client version and date, OAuth and refresh results, exact tool selected, receipt counts and provenance, Markdown/HTML/image presentation, and any relay errors. For a write-path test, get explicit authority for one synthetic scratch update on an existing disposable upstream. Exercise one successful update, one tool-level error, and one lookup. Close the session, inspect the resulting receipt, and confirm the roundup includes it once.
