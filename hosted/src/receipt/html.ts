import { assertNever, escapeHtml, formatInstant } from "../text";
import { serviceLabel } from "../proxy/summary";
import type { ActionTone } from "../proxy/classify";
import type { Change, ClaimResult, FieldChange, Receipt, ReceiptAction } from "./types";

const ICON_ADDED = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M7 1h2v14H7zM1 7h14v2H1z"/></svg>`;
const ICON_REMOVED = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 7h14v2H1z"/></svg>`;
const ICON_MODIFIED = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M12.1 1.4l2.5 2.5-8.2 8.2H3.9V9.6l8.2-8.2zM2 14h12v1.5H2z"/></svg>`;
const ICON_VERIFIED = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.2l3.2 3.2 7.3-7.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const ICON_MISSING = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.8"/></svg>`;

export function renderHtml(receipt: Receipt): string {
  const session = `Snapshot ${escapeHtml(formatInstant(receipt.session.startedAt, receipt.timeZone))} · checked ${escapeHtml(formatInstant(receipt.session.checkedAt, receipt.timeZone))}`;
  const headline = `${receipt.counts.added} added, ${receipt.counts.removed} removed, ${receipt.counts.modified} modified`;
  const repos = receipt.github.repos.length > 0 ? receipt.github.repos.join(", ") : "none";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Life Diff receipt ${escapeHtml(receipt.id)}</title>
<style>
  :root {
    color-scheme: light dark;
    --paper: #f3efe6;
    --ink: #1c1915;
    --muted: #5c564c;
    --card: #fffdf8;
    --line: #e4dccd;
    --mast: #1e3a32;
    --mast-ink: #f6f1e7;
    --added: #0f5c32;
    --added-bg: #e7f6ec;
    --removed: #8d1c1c;
    --removed-bg: #fdeeee;
    --modified: #6b4300;
    --modified-bg: #fff6e4;
    --neutral: #3f3a33;
    --neutral-bg: #efeae1;
    --read: #5c564c;
    --read-bg: #ece7de;
    --focus: #1e3a32;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #161310;
      --ink: #f4efe6;
      --muted: #c2b8a8;
      --card: #221e1a;
      --line: #3a332c;
      --mast: #10241e;
      --mast-ink: #f6f1e7;
      --added: #9ddec0;
      --added-bg: #143226;
      --removed: #f3b4ae;
      --removed-bg: #3a1717;
      --modified: #f0cb86;
      --modified-bg: #3a2c14;
      --neutral: #f4efe6;
      --neutral-bg: #2a251f;
      --read: #c2b8a8;
      --read-bg: #2a251f;
      --focus: #f0cb86;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font: 16px/1.5 "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  }
  main { max-width: 880px; margin: 0 auto; padding: 0 20px 64px; }
  header.mast {
    background: var(--mast);
    color: var(--mast-ink);
    padding: 28px 20px 22px;
  }
  header.mast .wrap { max-width: 880px; margin: 0 auto; }
  .word { font-family: Georgia, "Iowan Old Style", Palatino, serif; font-size: 34px; margin: 0; letter-spacing: -0.03em; }
  .lede { margin: 6px 0 0; color: #d9e6df; }
  .session { margin: 14px 0 0; font-size: 14px; }
  .headline { margin: 18px 0 0; font-size: 18px; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .badge, .tag {
    display: inline-flex; align-items: center; gap: 6px;
    border-radius: 999px; padding: 3px 10px; font-size: 13px; font-weight: 650;
    border: 1px solid transparent;
  }
  .badge svg, .tag svg { width: 14px; height: 14px; display: block; }
  .badge-added { background: var(--added-bg); color: var(--added); }
  .badge-removed { background: var(--removed-bg); color: var(--removed); }
  .badge-modified { background: var(--modified-bg); color: var(--modified); }
  .badge-read { background: var(--read-bg); color: var(--read); }
  .badge-unknown { background: var(--neutral-bg); color: var(--neutral); }
  .tag { background: var(--neutral-bg); color: var(--neutral); font-weight: 600; }
  section { margin-top: 28px; }
  h2 { font-family: Georgia, Palatino, serif; font-size: 26px; margin: 0 0 4px; }
  .intro { margin: 0 0 12px; color: var(--muted); }
  article.change {
    background: var(--card);
    border: 1px solid var(--line);
    border-left-width: 8px;
    border-radius: 12px;
    padding: 14px 16px 12px;
    margin: 12px 0;
  }
  article.is-added { border-left-color: var(--added); }
  article.is-removed { border-left-color: var(--removed); }
  article.is-modified { border-left-color: var(--modified); }
  article.is-read { border-left-color: var(--read); }
  article.is-unknown { border-left-color: var(--neutral); }
  details.reads, details.more { margin: 8px 0 16px; }
  details.more summary, details.reads summary { cursor: pointer; color: var(--muted); }
  pre.args {
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--neutral-bg);
    border-radius: 8px;
    padding: 8px;
    font-size: 13px;
  }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  h3 { font-family: Georgia, Palatino, serif; font-size: 20px; line-height: 1.35; font-weight: 600; margin: 0 0 10px; }
  .fields { display: grid; gap: 8px; margin: 0 0 8px; }
  .field { display: grid; grid-template-columns: 7.5rem 1fr; gap: 8px; align-items: baseline; }
  .field .label { color: var(--muted); font-size: 13px; }
  .compare { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .before, .after, .value {
    background: var(--neutral-bg);
    border-radius: 8px;
    padding: 4px 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .arrow { color: var(--muted); }
  .why, .empty, .note, .warn { color: var(--muted); margin: 4px 0; }
  .warn { color: var(--modified); }
  a { color: var(--focus); }
  footer { margin-top: 28px; color: var(--muted); font-size: 13px; }
  .claims article { border-left-color: var(--neutral); }
  .claims article.is-verified { border-left-color: var(--added); }
  .claims article.is-missing { border-left-color: var(--modified); }
  @media (max-width: 640px) {
    .field { grid-template-columns: 1fr; gap: 2px; }
  }
</style>
</head>
<body>
<header class="mast">
  <div class="wrap">
    <p class="word">Life Diff</p>
    <p class="lede">One receipt of what the agent did. Gray is a lookup. Green, amber, and red are changes.</p>
    <p class="session">${session}</p>
    <p class="headline">${escapeHtml(headline)}</p>
    <div class="legend" aria-label="Legend">
      <span class="badge badge-added">${ICON_ADDED} Created</span>
      <span class="badge badge-modified">${ICON_MODIFIED} Changed</span>
      <span class="badge badge-removed">${ICON_REMOVED} Deleted</span>
      <span class="badge badge-read">Read</span>
    </div>
  </div>
</header>
<main>
  ${renderProxy(receipt)}
  <section>
    <h2>GitHub</h2>
    <p class="intro">Verified from service history. Repositories compared with the snapshot: ${escapeHtml(repos)}.</p>
    ${receipt.changes.length === 0 ? `<p class="empty">Nothing changed in the repositories Life Diff could read.</p>` : receipt.changes.map(renderChange).join("")}
  </section>
  ${renderClaims(receipt)}
  ${renderWarnings(receipt)}
  <section>
    <h2>How to read this</h2>
    ${receipt.notes.map((note) => `<p class="note">${escapeHtml(note)}</p>`).join("")}
  </section>
  <footer>Receipt ${escapeHtml(receipt.id)} · schema 1.0.0 · Life Diff did not change any GitHub data.</footer>
</main>
</body>
</html>
`;
}

function renderProxy(receipt: Receipt): string {
  const actions = receipt.actions;
  if (!actions) return "";
  if (actions.length === 0) {
    return `<section><h2>Tool calls</h2><p class="intro">Reported by the proxy.</p><p class="empty">No tool calls were reported by the proxy during this session.</p></section>`;
  }
  const groups = new Map<string, ReceiptAction[]>();
  for (const action of actions) {
    const list = groups.get(action.upstream) ?? [];
    list.push(action);
    groups.set(action.upstream, list);
  }
  return [...groups.entries()].map(([upstream, items]) => {
    const writes = items.filter((item) => item.tone !== "read");
    const reads = items.filter((item) => item.tone === "read");
    const readBody = reads.length === 0 ? "" : `<details class="reads"><summary>${reads.length} lookup${reads.length === 1 ? "" : "s"}</summary>${reads.map((item) => renderAction(item, receipt.timeZone)).join("")}</details>`;
    return `<section>
      <h2>${escapeHtml(serviceLabel(upstream))}</h2>
      <p class="intro">Reported by the proxy. These are calls Life Diff forwarded to ${escapeHtml(serviceLabel(upstream))}. They are not a history ${escapeHtml(serviceLabel(upstream))} confirmed.</p>
      ${writes.length === 0 ? `<p class="empty">No changes recorded.</p>` : writes.map((item) => renderAction(item, receipt.timeZone)).join("")}
      ${readBody}
    </section>`;
  }).join("");
}

function renderAction(action: ReceiptAction, timeZone: string): string {
  const tone = toneClass(action.tone);
  const when = escapeHtml(formatInstant(action.time, timeZone));
  const status = action.ok ? "Finished" : "Error";
  const args = escapeHtml(JSON.stringify(action.arguments ?? {}, null, 2));
  return `<article class="change is-${tone}">
      <div class="meta">
        <span class="badge badge-${tone}">${escapeHtml(toneLabel(action))}</span>
        <span class="tag">Reported by proxy</span>
        <span class="tag">${escapeHtml(status)}</span>
      </div>
      <h3>${escapeHtml(action.summary)}</h3>
      <details class="more">
        <summary>Details</summary>
        <p class="why">${when} · ${escapeHtml(action.tool)} · ${action.durationMs} ms</p>
        ${action.error ? `<p class="warn">${escapeHtml(action.error)}</p>` : ""}
        ${action.resultSummary ? `<p>${escapeHtml(action.resultSummary)}</p>` : ""}
        <pre class="args">${args}</pre>
      </details>
    </article>`;
}

function toneClass(tone: ActionTone): string {
  switch (tone) {
    case "added":
      return "added";
    case "changed":
      return "modified";
    case "removed":
      return "removed";
    case "read":
      return "read";
    case "unknown":
      return "unknown";
    default:
      return assertNever(tone, "action tone");
  }
}

function toneLabel(action: ReceiptAction): string {
  switch (action.tone) {
    case "added":
      return "Created";
    case "changed":
      return "Changed";
    case "removed":
      return action.tool.toLowerCase().includes("send") ? "Sent" : "Deleted";
    case "read":
      return "Read";
    case "unknown":
      return "Unknown";
    default:
      return assertNever(action.tone, "action tone");
  }
}

function renderChange(change: Change): string {
  const actor = change.actor?.login ? `<span class="tag">${escapeHtml(change.actor.login)}</span>` : "";
  const app = change.viaApp?.name || change.viaApp?.slug;
  const via = app ? `<span class="tag">${escapeHtml(app)}</span>` : "";
  const claim = change.claimStatus ? `<span class="tag">${escapeHtml(claimLabel(change.claimStatus))}</span>` : "";
  const link = change.link ? `<p><a href="${escapeHtml(change.link)}">Open on GitHub</a></p>` : "";
  return `<article class="change is-${change.kind}">
      <div class="meta">
        <span class="badge badge-${change.kind}">${iconFor(change.kind)}${escapeHtml(kindLabel(change.kind))}</span>
        <span class="tag">Verified from service history</span>
        <span class="tag">${escapeHtml(confidenceLabel(change.confidence))}</span>
        ${claim}${actor}${via}
      </div>
      <h3>${escapeHtml(change.summary)}</h3>
      ${change.fields.length > 0 ? `<div class="fields">${change.fields.map((field) => renderField(field, change.kind)).join("")}</div>` : ""}
      <p class="why">${escapeHtml(change.confidenceReason)}</p>
      ${link}
    </article>`;
}

function renderField(field: FieldChange, kind: Change["kind"]): string {
  if (kind === "modified") {
    return `<div class="field"><div class="label">${escapeHtml(field.label)}</div><div><div class="compare"><span class="before">${escapeHtml(field.before)}</span><span class="arrow" aria-hidden="true">→</span><span class="after">${escapeHtml(field.after)}</span></div></div></div>`;
  }
  const value = kind === "removed" ? field.before || field.after : field.after || field.before;
  if (!value.trim()) return "";
  return `<div class="field"><div class="label">${escapeHtml(field.label)}</div><div><span class="value">${escapeHtml(value)}</span></div></div>`;
}

function renderClaims(receipt: Receipt): string {
  if (!receipt.claimsChecked) return "";
  const body = receipt.claims.length === 0
    ? `<p class="empty">The agent claimed that nothing changed.</p>`
    : receipt.claims.map(renderClaim).join("");
  return `<section class="claims">
    <h2>What the agent said</h2>
    <p class="intro">Each claim is marked verified when GitHub shows a matching change, or missing when it does not. Claims include actions the agent logged through Life Diff.</p>
    ${body}
  </section>`;
}

function renderClaim(claim: ClaimResult): string {
  const verified = claim.status === "verified";
  const title = `${verified ? "Verified" : "Missing"} ${JSON.stringify(claim.target)} in GitHub${claim.action ? ` (${claim.action})` : ""}`;
  return `<article class="change is-${claim.status}">
      <div class="meta">
        <span class="badge ${verified ? "badge-added" : "badge-modified"}">${verified ? ICON_VERIFIED : ICON_MISSING} ${verified ? "Verified" : "Missing"}</span>
      </div>
      <h3>${escapeHtml(title)}</h3>
      ${claim.detail ? `<p>${escapeHtml(claim.detail)}</p>` : ""}
      <p class="why">${escapeHtml(claim.reason)}</p>
    </article>`;
}

function renderWarnings(receipt: Receipt): string {
  if (!receipt.warnings || receipt.warnings.length === 0) return "";
  return `<section><h2>Check notes</h2>${receipt.warnings.map((warning) => `<p class="warn">${escapeHtml(warning)}</p>`).join("")}</section>`;
}

function iconFor(kind: Change["kind"]): string {
  switch (kind) {
    case "added":
      return ICON_ADDED;
    case "removed":
      return ICON_REMOVED;
    case "modified":
      return ICON_MODIFIED;
    default:
      return assertNever(kind, "change kind");
  }
}

function kindLabel(kind: Change["kind"]): string {
  switch (kind) {
    case "added":
      return "Added";
    case "removed":
      return "Removed";
    case "modified":
      return "Modified";
    default:
      return assertNever(kind, "change kind");
  }
}

function confidenceLabel(level: Change["confidence"]): string {
  switch (level) {
    case "high":
      return "High confidence";
    case "medium":
      return "Medium confidence";
    case "low":
      return "Low confidence";
    default:
      return assertNever(level, "confidence");
  }
}

function claimLabel(status: NonNullable<Change["claimStatus"]>): string {
  switch (status) {
    case "verified":
      return "Verified";
    case "missing":
      return "Missing";
    case "unclaimed":
      return "Not claimed";
    default:
      return assertNever(status, "claim status");
  }
}
