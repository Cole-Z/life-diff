import { escapeHtml } from "../text";

export interface ConsentView {
  clientName: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scope: string[];
  clientDomain?: string;
}

export function renderConsentPage(view: ConsentView, handle: string): string {
  const scopes = view.scope.map((scope) => `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scopeLabel(scope))}</label>`).join("");
  const domain = view.clientDomain ? `<p>The client says it is hosted at <strong>${escapeHtml(view.clientDomain)}</strong>.</p>` : "";
  const loopback = view.redirectIsLoopback ? `<p>This sends access to an app on your computer. Any local program could be listening.</p>` : "";
  return layout("Allow Life Diff", `<h1>Allow ${escapeHtml(view.clientName)} to use Life Diff?</h1>
    <p>Life Diff will send this client its own access token. The GitHub token stays on Life Diff.</p>
    <p>Tokens will be sent to <strong>${escapeHtml(view.redirectHost)}</strong>.</p>
    ${domain}
    ${loopback}
    <form method="post">
      <input type="hidden" name="handle" value="${escapeHtml(handle)}">
      <fieldset>
        <legend>What this client can do</legend>
        ${scopes}
      </fieldset>
      <button name="decision" value="approve">Continue to GitHub</button>
      <button name="decision" value="deny">Deny</button>
    </form>`);
}

export function renderHome(): string {
  return layout("Life Diff", `<h1>Life Diff</h1>
    <p>A read-only receipt of what changed on GitHub during an agent session.</p>
    <p>Connect an MCP client to <code>/mcp</code>. Life Diff signs you in with a GitHub App, then an agent can snapshot a session and read the diff.</p>
    <p>Google Calendar and Drive stay in the self-run Life Diff command. This hosted service does not use Google.</p>
    <p><a href="/privacy">Privacy</a> · <a href="/account">Account</a></p>`);
}

export function renderPrivacy(): string {
  return layout("Privacy", `<h1>Privacy</h1>
    <p>Life Diff stores your GitHub login, an encrypted GitHub token, session snapshots, action logs, and receipts. It does not store file bodies and it does not write to GitHub.</p>
    <p>Snapshots of an open session are kept for 7 days if you never end it. After a session ends, the snapshot is kept for 24 hours and the receipt for 90 days. Those are the defaults.</p>
    <p>Signed-in users can delete everything from the <a href="/account">account page</a>. An agent can call <code>DELETE /v1/me</code> with its Life Diff token.</p>
    <p>This is a draft for review. The full note is in PRIVACY.md.</p>`);
}

export function renderAccount(login: string, csrf: string): string {
  return layout("Account", `<h1>Account</h1>
    <p>Signed in as <strong>${escapeHtml(login)}</strong>.</p>
    <p>Deleting your data removes GitHub tokens, sessions, snapshots, receipts, and Life Diff access grants. It does not change anything on GitHub. Uninstall the GitHub App in GitHub settings as well.</p>
    <form method="post" action="/account/delete">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <button name="confirm" value="delete">Delete my Life Diff data</button>
    </form>`);
}

export function renderDeleted(): string {
  return layout("Deleted", `<h1>Your Life Diff data was deleted</h1>
    <p>Tokens, sessions, snapshots, and receipts for this account are gone. GitHub itself was not changed.</p>
    <p>Uninstall the Life Diff GitHub App from your GitHub settings if you do not want it installed.</p>`);
}

export function renderMcpBrowserPage(endpoint: string): string {
  return layout("Life Diff MCP", `<h1>This is the Life Diff MCP endpoint</h1>
    <p>Add <code>${escapeHtml(endpoint)}</code> as a remote MCP server in an MCP client.</p>`);
}

export function renderSignedOut(): string {
  return layout("Account", `<h1>Account</h1>
    <p>Sign in from an MCP client first. Life Diff sets a browser session when GitHub sends you back, and this page uses that session.</p>`);
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case "receipts:read":
      return "Read receipts";
    case "sessions:write":
      return "Start sessions and log claimed actions";
    default:
      return scope;
  }
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --paper: #f3efe6; --ink: #1c1915; --mast: #1e3a32; --mast-ink: #f6f1e7; --card: #fffdf8; --line: #e4dccd; }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #161310; --ink: #f4efe6; --mast: #10241e; --card: #221e1a; --line: #3a332c; }
  }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 "Segoe UI", Helvetica, Arial, sans-serif; }
  header { background: var(--mast); color: var(--mast-ink); padding: 28px 20px; }
  header p { font-family: Georgia, Palatino, serif; font-size: 34px; margin: 0; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 20px 64px; }
  form, fieldset { display: grid; gap: 12px; }
  button { font: inherit; padding: 8px 14px; }
  a { color: var(--mast); }
</style>
</head>
<body>
<header><p>Life Diff</p></header>
<main>${body}</main>
</body>
</html>`;
}
