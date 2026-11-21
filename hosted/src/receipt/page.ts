import { escapeHtml } from "../text";
import { markerFor, serviceLabel, trustLabel, type StoryLine } from "./story";

const ICON_ADDED = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M7 1h2v14H7zM1 7h14v2H1z"/></svg>`;
const ICON_REMOVED = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M1 7h14v2H1z"/></svg>`;
const ICON_MODIFIED = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M12.1 1.4l2.5 2.5-8.2 8.2H3.9V9.6l8.2-8.2zM2 14h12v1.5H2z"/></svg>`;

export function renderDiffPage(input: {
  title: string;
  lede: string;
  headline: string;
  when: string;
  lines: StoryLine[];
  notes?: string[];
  extra?: string;
  footer: string;
}): string {
  const clients = new Set(input.lines.map((line) => line.client).filter((client): client is string => Boolean(client)));
  const groups = group(input.lines);
  const body = groups.length === 0
    ? `<p class="empty">No changes.</p>`
    : groups.map((item) => renderGroup(item, clients.size > 1)).join("");
  const notes = (input.notes ?? []).map((note) => `<p class="note">${escapeHtml(note)}</p>`).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
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
    --failed: #8d1c1c;
    --failed-bg: #fdeeee;
    --read: #5c564c;
    --read-bg: #efeae1;
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
      --added: #9ddec0;
      --added-bg: #143226;
      --removed: #f3b4ae;
      --removed-bg: #3a1717;
      --modified: #f0cb86;
      --modified-bg: #3a2c14;
      --failed: #f3b4ae;
      --failed-bg: #3a1717;
      --read: #c2b8a8;
      --read-bg: #2a251f;
      --focus: #f0cb86;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.45 "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif; }
  header.mast { background: var(--mast); color: var(--mast-ink); padding: 28px 20px 22px; }
  header.mast .wrap, main { max-width: 880px; margin: 0 auto; }
  main { padding: 8px 20px 64px; }
  .word { font-family: Georgia, "Iowan Old Style", Palatino, serif; font-size: 34px; margin: 0; letter-spacing: -0.03em; }
  .lede, .when { margin: 6px 0 0; }
  .headline { margin: 14px 0 0; font-size: 20px; font-weight: 650; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .badge, .tag { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 3px 10px; font-size: 13px; font-weight: 650; }
  .badge svg { width: 14px; height: 14px; }
  .badge-added { background: var(--added-bg); color: var(--added); }
  .badge-removed { background: var(--removed-bg); color: var(--removed); }
  .badge-modified { background: var(--modified-bg); color: var(--modified); }
  .badge-failed { background: var(--failed-bg); color: var(--failed); }
  .badge-read { background: var(--read-bg); color: var(--read); }
  section { margin-top: 22px; }
  .svc { display: flex; align-items: center; gap: 10px; margin: 0 0 8px; }
  .icon { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; background: var(--mast); color: var(--mast-ink); font-weight: 700; }
  h2 { font-family: Georgia, Palatino, serif; font-size: 22px; margin: 0; }
  .source { color: var(--muted); font-size: 13px; margin: 0 0 8px; }
  article.row { background: var(--card); border: 1px solid var(--line); border-left-width: 8px; border-radius: 12px; padding: 12px 14px; margin: 8px 0; }
  article.is-created { border-left-color: var(--added); }
  article.is-changed { border-left-color: var(--modified); }
  article.is-removed { border-left-color: var(--removed); }
  article.is-failed { border-left-color: var(--failed); }
  article.is-read, article.is-unknown { border-left-color: var(--read); }
  .summary { margin: 0; font-size: 17px; }
  article.is-failed .summary { color: var(--failed); font-weight: 650; }
  h3.repo { font-size: 15px; margin: 14px 0 4px; color: var(--muted); font-family: "Segoe UI", Helvetica, Arial, sans-serif; font-weight: 650; }
  .compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
  .compare.single { grid-template-columns: 1fr; }
  .before, .after { background: var(--read-bg); border-radius: 8px; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; }
  .before { text-decoration: line-through; text-decoration-color: var(--removed); }
  .k { display: block; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); text-decoration: none; }
  details { margin-top: 8px; }
  details summary { cursor: pointer; color: var(--focus); }
  ul { margin: 8px 0 0; padding-left: 18px; }
  a { color: var(--focus); }
  .note, .empty, .undo, footer { color: var(--muted); }
  .undo { margin: 8px 0 0; font-size: 14px; }
  footer { margin-top: 28px; font-size: 13px; }
  @media (max-width: 640px) {
    .word { font-size: 28px; }
    main { padding: 8px 14px 48px; }
    .compare { grid-template-columns: 1fr; }
    .summary { font-size: 16px; }
  }
</style>
</head>
<body>
<header class="mast">
  <div class="wrap">
    <p class="word">Life Diff</p>
    <p class="lede">${escapeHtml(input.lede)}</p>
    <p class="when">${escapeHtml(input.when)}</p>
    <p class="headline">${escapeHtml(input.headline)}</p>
    <div class="legend" aria-label="Legend">
      <span class="badge badge-added">${ICON_ADDED}Added</span>
      <span class="badge badge-modified">${ICON_MODIFIED}Modified</span>
      <span class="badge badge-removed">${ICON_REMOVED}Removed</span>
      <span class="badge badge-failed">Failed</span>
      <span class="badge badge-read">Read</span>
    </div>
  </div>
</header>
<main>
  ${body}
  ${notes ? `<section><h2>How to read this</h2>${notes}</section>` : ""}
  ${input.extra ?? ""}
  <footer>${escapeHtml(input.footer)}</footer>
</main>
</body>
</html>`;
}

function group(lines: StoryLine[]): { service: string; lines: StoryLine[] }[] {
  const groups = new Map<string, { service: string; lines: StoryLine[] }>();
  for (const line of lines) {
    const existing = groups.get(line.service) ?? { service: line.service, lines: [] };
    existing.lines.push(line);
    groups.set(line.service, existing);
  }
  return [...groups.values()];
}

function renderGroup(groupLines: { service: string; lines: StoryLine[] }, showClient: boolean): string {
  const letter = (groupLines.service.trim().charAt(0) || "S").toUpperCase();
  const repos = new Map<string, StoryLine[]>();
  for (const line of groupLines.lines) {
    const key = line.repo ?? "";
    const list = repos.get(key) ?? [];
    list.push(line);
    repos.set(key, list);
  }
  const blocks = [...repos.entries()].map(([repo, lines]) => {
    const heading = repo ? `<h3 class="repo">${escapeHtml(repoTitle(repo, lines, showClient))}</h3>` : "";
    return `${heading}${lines.map((line) => renderLine(line, showClient)).join("")}`;
  }).join("");
  return `<section>
    <div class="svc"><span class="icon" aria-hidden="true">${escapeHtml(letter)}</span><h2>${escapeHtml(serviceLabel(groupLines.service))}</h2></div>
    ${blocks}
  </section>`;
}

function repoTitle(repo: string, lines: StoryLine[], showClient: boolean): string {
  const clients = new Set(lines.map((line) => line.client).filter((client): client is string => Boolean(client)));
  const client = clients.size === 1 ? [...clients][0] : undefined;
  const writes = lines.filter((line) => line.write && line.tone !== "failed" && line.tone !== "read");
  if (showClient && client && writes.length === 1) {
    const summary = writes[0]?.summary ?? "";
    const kind = summary.includes("pull request") ? "pull request opened" : summary.includes("issue") ? "issue" : "change";
    return `${repo}: 1 ${kind} by ${client}`;
  }
  if (showClient && client) return `${repo} · ${client}`;
  return repo;
}

function renderLine(line: StoryLine, showClient: boolean): string {
  const who = showClient && line.client && !line.repo ? ` · ${line.client}` : "";
  if (line.tone === "note") {
    const text = line.summary.endsWith(".") ? line.summary : `${line.summary}.`;
    return `<p class="note">${escapeHtml(text)}</p>`;
  }
  if (line.tone === "read" && line.details && line.details.length > 0 && line.readCount) {
    const items = line.details.map((detail) => `<li>${escapeHtml(detail.text)}</li>`).join("");
    const trust = line.trust ? ` · ${line.trust}` : "";
    return `<details class="reads"><summary>${escapeHtml(markerFor(line.tone))} ${escapeHtml(line.summary)}${escapeHtml(trust)}${escapeHtml(who)}</summary><ul>${items}</ul></details>`;
  }
  const pairs = (line.details ?? []).filter((detail) => detail.before || detail.after);
  const extras = (line.details ?? []).filter((detail) => !detail.before && !detail.after);
  const compare = pairs.slice(0, 2).map((detail) => {
    const before = detail.before ? `<div class="before"><span class="k">Before ${escapeHtml(detail.text)}</span>${escapeHtml(detail.before)}</div>` : "";
    const after = `<div class="after"><span class="k">${detail.before ? "After" : escapeHtml(detail.text)}</span>${escapeHtml(detail.after ?? "")}</div>`;
    return `<div class="compare${before ? "" : " single"}">${before}${after}</div>`;
  }).join("");
  const more = extras.length > 0 || pairs.length > 2
    ? `<details><summary>${extras.length > 0 ? `${extras.length} ${extras.length === 1 ? "detail" : "details"}` : "More"}</summary><ul>${[...pairs.slice(2), ...extras].map((detail) => `<li>${escapeHtml(detailText(detail))}</li>`).join("")}</ul></details>`
    : "";
  const link = line.link?.startsWith("https://") ? `<p><a href="${escapeHtml(line.link)}">Open</a></p>` : "";
  const undo = line.hint ? `<p class="undo">${escapeHtml(line.hint)}</p>` : "";
  const badge = line.trust ?? trustLabel(line.source);
  const trust = badge || who ? `<div class="meta"><span class="tag">${escapeHtml(`${badge}${who}`)}</span></div>` : "";
  return `<article class="row is-${line.tone}">
    ${trust}
    <p class="summary">${escapeHtml(markerFor(line.tone))} ${escapeHtml(line.summary)}</p>
    ${compare}
    ${undo}
    ${more}
    ${link}
  </article>`;
}

function detailText(detail: { text: string; before?: string; after?: string }): string {
  if (detail.before || detail.after) return `${detail.text}: ${detail.before ?? ""} → ${detail.after ?? ""}`;
  return detail.text;
}
