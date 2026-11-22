import { receiptStyles } from "../receipt/page";
import { renderSampleCard } from "../receipt/sample";
import { copyTextScript } from "./copy";
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

const clientGuide = "https://github.com/Cole-Z/life-diff/blob/main/docs/connect.md";

export function renderHome(endpoint: string): string {
  return layout("Life Diff · Receipts for AI tool activity", `
    <h1 class="hero-title">Get a receipt for what your AI agents changed.</h1>
    <p class="hero-copy">Life Diff is a hosted MCP proxy with session receipts and a daily roundup. Receipts show tool calls routed through Life Diff, changes your agent reports, and optional checks on GitHub repositories you name.</p>
    <p class="actions"><a class="action primary" href="/sample-receipt">See a sample receipt</a><a class="action" href="#connect">Connect your client</a></p>
    ${renderSampleCard(true)}
    <section class="setup" aria-labelledby="connect">
      <h2 id="connect" tabindex="-1">Connect your client</h2>
      <ol>
        <li><strong>Add Life Diff.</strong> Open the <a href="${clientGuide}">client setup guide</a> and add the endpoint as a remote Streamable HTTP MCP server.
          ${endpointInput(endpoint)}
        </li>
        <li><strong>Sign in with GitHub.</strong> Approve the Life Diff access prompts in your client. GitHub signs you into the hosted service. Repository checks require a separate opt-in.</li>
        <li><strong>Run a first lookup.</strong> Add DeepWiki as an upstream, a tool server whose calls you want routed through Life Diff. Follow the <a href="${clientGuide}#first-lookup">read-only smoke test</a> to make one lookup and open its receipt.</li>
      </ol>
    </section>
    <nav aria-label="Life Diff"><a href="/settings">Settings</a><a href="/roundup">Today</a><a href="/account">Account</a><a href="/privacy">Privacy</a></nav>`, true);
}

export function renderSample(): string {
  return layout("Sample receipt · Life Diff", `${renderSampleCard()}
    <p class="actions"><a class="action primary" href="/#connect">Connect your client</a><a href="/">Back to Life Diff</a></p>`, true);
}

function endpointInput(endpoint: string): string {
  return `<div class="endpoint" data-copy-group>
    <label for="mcp-endpoint">MCP endpoint</label>
    <div class="actions">
      <input id="mcp-endpoint" value="${escapeHtml(endpoint)}" data-copy-value readonly spellcheck="false">
      <button type="button" data-copy>Copy endpoint</button>
    </div>
    <span role="status"></span>
  </div>${copyTextScript}`;
}

export function renderPrivacy(): string {
  return layout("Privacy · Life Diff", `<h1>Hosted privacy</h1>
    <p>GitHub signs you in. Life Diff stores your GitHub ID and login, encrypted GitHub credentials, app installation IDs, preferences, and MCP grants. GitHub checks use metadata from repositories you explicitly name and have made available to the app.</p>
    <p>Life Diff stores registered upstream URLs and encrypted credentials. Receipts and action logs can contain bounded tool arguments, result or error excerpts, and agent-reported text. Those fields can include ordinary file, message, or document content. Redaction masks secret-like fields and recognized patterns and can miss sensitive content. Calls go to their upstream with the original arguments.</p>
    <p>Defaults are 90 days for receipts, 24 hours for snapshots after close, and seven days for abandoned sessions. Hourly maintenance applies those limits. Daily pages have no separate age limit.</p>
    <p>GitHub sign-in sets a seven-day browser session. Approved clients can use their Life Diff tokens. Anyone holding a signed HTML link can view its specific receipt or day for 24 hours, subject to the data still being available. Card image URLs also contain access credentials. Keep these URLs private.</p>
    <p><a href="/settings">Clear history</a> removes saved sessions, receipts, and daily pages and keeps your sign-in, settings, and upstreams. <a href="/account">Delete my Life Diff data</a> also removes the Life Diff account, credentials, and grants. GitHub authorizations are managed separately on GitHub.</p>
    <p><a href="https://github.com/Cole-Z/life-diff/blob/main/PRIVACY.md">Full hosted data and privacy details</a></p>`);
}

export function renderAccount(login: string, csrf: string): string {
  return layout("Account", `<h1>Account</h1>
    <p>Signed in as <strong>${escapeHtml(login)}</strong>.</p>
    <p><a href="/settings">Manage upstream MCP servers</a></p>
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
    <p>Add this URL as a remote MCP server in your client and sign in with GitHub when prompted.</p>
    ${endpointInput(endpoint)}
    ${setupLinks()}`);
}

export interface SettingsUpstream {
  name: string;
  url: string;
  hasToken: boolean;
}

export interface SettingsView {
  timeZone: string;
  dayEnd: string;
  githubDaily: boolean;
  idleMinutes: number;
  quietDays: boolean;
}

export function renderSettings(login: string, csrf: string, upstreams: SettingsUpstream[], settings: SettingsView, error?: string): string {
  const rows = upstreams.length === 0
    ? `<p>No upstreams yet. Add the MCP server your agent should call through Life Diff.</p>`
    : upstreams.map((item) => `<li>
        <strong>${escapeHtml(item.name)}</strong>
        <div><code>${escapeHtml(item.url)}</code></div>
        <div>${item.hasToken ? "Token saved" : "No token"} · Registered for discovery</div>
        <form method="post" action="/settings/remove">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="name" value="${escapeHtml(item.name)}">
          <button>Remove</button>
        </form>
      </li>`).join("");
  const message = error ? `<p role="alert">${escapeHtml(error)}</p>` : "";
  return layout("Settings", `<h1>Settings</h1>
    <p>Signed in as <strong>${escapeHtml(login)}</strong>. A day is your local calendar day. An hourly job saves the roundup after your workday ends.</p>
    ${message}
    <form method="post" action="/settings/preferences">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label>Time zone <input name="timeZone" required value="${escapeHtml(settings.timeZone)}" placeholder="America/Chicago"></label>
      <label>End of workday <input name="dayEnd" type="time" required value="${escapeHtml(settings.dayEnd)}"></label>
      <label><input type="checkbox" name="githubDaily" value="on" ${settings.githubDaily ? "checked" : ""}> Include GitHub repository changes in the daily diff</label>
      <p>Off until you turn it on. Life Diff only reads repositories you name in <code>start_session</code>.</p>
      <label>Idle minutes before a session is eligible to close <input name="idleMinutes" type="number" min="5" max="180" required value="${escapeHtml(String(settings.idleMinutes))}"></label>
      <p>An eligible session is finalized on the next session-opening activity or scheduled sweep. Use <code>end_session</code> to close it now.</p>
      <label><input type="checkbox" name="quietDays" value="on" ${settings.quietDays ? "checked" : ""}> Don't save the daily page when nothing changed</label>
      <button>Save</button>
    </form>
    <h2>Tools your agents use</h2>
    <p>Registration saves the connection for discovery. Refresh or reconnect your client and look for <code>name__tool</code> to confirm the upstream published tools.</p>
    ${upstreams.length ? `<ul>${rows}</ul>` : rows}
    <form method="post" action="/settings">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label>Name <input name="name" required maxlength="33" autocomplete="off"></label>
      <label>URL <input name="url" type="url" required placeholder="https://mcp.deepwiki.com/mcp"></label>
      <label>Token, optional <input name="token" type="password" autocomplete="off"></label>
      <button>Add upstream</button>
    </form>
    <p>If tools are missing, check the upstream URL and credentials, then refresh or reconnect. An upstream may be unreachable or publish zero tools. <a href="${clientGuide}#troubleshooting">Troubleshoot discovery</a></p>
    <h2>History</h2>
    <p>This deletes sessions, receipts, and daily diffs for this account. Upstream servers and the GitHub sign-in stay.</p>
    <form method="post" action="/settings/clear">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label><input type="checkbox" name="confirm" value="yes" required> Delete my Life Diff history</label>
      <button>Clear my history</button>
    </form>`);
}

export function renderSignedOut(page: "Account" | "Settings" | "Today"): string {
  const purpose = {
    Account: "Manage your Life Diff account and data after signing in.",
    Settings: "Manage upstream tools and receipt preferences after signing in.",
    Today: "See the daily roundup of your sessions after signing in.",
  }[page];
  return layout(`${page} · Life Diff`, `<h1>${page}</h1>
    <p>${purpose} Sign in with GitHub from your MCP client, then return here in the same browser.</p>
    ${setupLinks()}`);
}

function setupLinks(): string {
  return `<p class="actions"><a class="action primary" href="/#connect">Connect your client</a><a href="/sample-receipt">See a sample receipt</a></p>`;
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

function layout(title: string, body: string, receipt = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  ${receipt ? receiptStyles : ""}
  :root { color-scheme: light dark; --paper: #f3efe6; --ink: #1c1915; --mast: #1e3a32; --mast-ink: #f6f1e7; --surface: #fffdf8; --link: #1b5342; --focus: #205bb1; }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #161310; --ink: #f4efe6; --mast: #10241e; --surface: #221e1a; --link: #9de1bf; --focus: #f5a524; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 "Segoe UI", Helvetica, Arial, sans-serif; overflow-wrap: anywhere; }
  header { background: var(--mast); color: var(--mast-ink); padding: 12px 20px; }
  header p { max-width: 720px; margin: 0 auto; font: 26px/1.5 Georgia, Palatino, serif; }
  header a { color: inherit; text-decoration: none; }
  header a:hover { text-decoration: underline; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 20px 64px; }
  h1, h2 { line-height: 1.12; }
  .hero-title { font: 700 clamp(2.15rem, 1.5rem + 3.5vw, 3.6rem)/1.06 Georgia, Palatino, serif; max-width: 18ch; margin: 0; }
  .hero-copy { max-width: 61ch; font-size: 1.08rem; }
  .actions, nav { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; }
  .action, button { display: inline-block; border: 1px solid currentColor; border-radius: 8px; padding: 8px 14px; font: inherit; }
  .action { text-decoration: none; }
  .action:hover { text-decoration: underline; }
  .action.primary { background: var(--mast); color: var(--mast-ink); }
  .setup { margin-block: 32px; }
  ol { padding-inline-start: 24px; }
  li + li { margin-top: 12px; }
  form, fieldset { display: grid; gap: 12px; min-inline-size: 0; }
  button { cursor: pointer; }
  input:not([type=checkbox]) { max-width: 100%; padding: 6px; font: inherit; }
  .endpoint { margin: 8px 0 14px; }
  .endpoint label { display: block; font-size: .875rem; }
  .endpoint input { width: min(100%, 28ch); min-width: 0; background: var(--surface); color: var(--ink); }
  [role=status] { font-size: .875rem; }
  a { color: var(--link); }
  :focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
  header :focus-visible, .action.primary:focus-visible { outline-color: var(--mast-ink); }
  .action.primary:focus-visible { outline-offset: -5px; }
</style>
</head>
<body>
<header><p><a href="/">Life Diff</a></p></header>
<main>${body}</main>
</body>
</html>`;
}
