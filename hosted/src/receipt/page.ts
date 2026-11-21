import { escapeHtml } from "../text";
import { shortService } from "./names";
import { agentTitle, displayTone, footerFor, kindName, markerFor, repoGroups, rowBody, summaryChips, trustLabel, type StoryLine } from "./story";
import { undoLabel } from "./undo";

const CHECK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.2l3.1 3.1L13 4.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

export function renderDiffPage(input: {
  title: string;
  eyebrow: string;
  lines: StoryLine[];
  timeZone?: string;
  startedAt?: string;
  endedAt?: string;
  receiptId?: string;
  notes?: string[];
  footerNote?: string;
}): string {
  const rows = input.lines.filter((line) => line.tone !== "note" && line.tone !== "unknown" && !(line.tone === "read" && line.readCount));
  const clients = new Set(input.lines.map((line) => line.client).filter((client): client is string => Boolean(client)));
  const heading = agentTitle(input.lines, input.timeZone, input.startedAt, input.endedAt);
  const chips = summaryChips(input.lines);
  const footer = footerFor(input.lines);
  const undoable = rows.filter((line) => line.undo && line.id);
  const sessionHref = input.receiptId && undoable.length > 0 ? `/receipts/${encodeURIComponent(input.receiptId)}/undo` : "";
  const body = renderGrouped(rows, clients.size > 1, input.receiptId);
  const notes = (input.notes ?? []).map((note) => `<p>${escapeHtml(note)}</p>`).join("");
  const chipHtml = chips.map((chip) => `<span class="count kind-${chip.kind}">${escapeHtml(chip.symbol)}${chip.count} ${escapeHtml(chip.label)}</span>`).join("");
  const undoButton = sessionHref
    ? `<a class="undo-session" href="${escapeHtml(sessionHref)}">Undo session…</a>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --page: #efeae2;
    --card: #fffdf8;
    --ink: #1c1915;
    --muted: #6d655b;
    --line: #e4dccd;
    --added: #0f7a45;
    --added-bg: #e7f6ec;
    --changed: #9a6700;
    --changed-bg: #fff4df;
    --removed: #a32020;
    --removed-bg: #fdeeee;
    --moved: #1d4f91;
    --moved-bg: #e7f0fb;
    --shared: #1d4f91;
    --shared-bg: #e7f0fb;
    --failed: #a32020;
    --failed-bg: #fdeeee;
    --missing: #6d655b;
    --missing-bg: #f3efe8;
    --unchecked: #8a5a12;
    --unchecked-bg: #f8f1e4;
    --link: #1d4f91;
    --focus: #1d4f91;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #100e0c;
      --card: #1c1916;
      --ink: #f4efe6;
      --muted: #a39888;
      --line: #3a332c;
      --added: #3dd68c;
      --added-bg: #163228;
      --changed: #f5a524;
      --changed-bg: #3a2c14;
      --removed: #f07167;
      --removed-bg: #3a1717;
      --moved: #7cb7ff;
      --moved-bg: #17283f;
      --shared: #7cb7ff;
      --shared-bg: #17283f;
      --failed: #f07167;
      --failed-bg: #3a1717;
      --missing: #a39888;
      --missing-bg: #2a261f;
      --unchecked: #e0b15c;
      --unchecked-bg: #332816;
      --link: #7cb7ff;
      --focus: #f5a524;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.45 "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif; }
  main { max-width: 720px; margin: 28px auto; padding: 0 16px 48px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 22px 22px 16px; }
  .eyebrow { margin: 0; font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); font-weight: 650; }
  h1 { margin: 8px 0 0; font-size: 22px; font-weight: 650; letter-spacing: -0.02em; }
  .undo-session { display: inline-block; margin-top: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; color: var(--ink); text-decoration: none; font-size: 14px; }
  .undo-session:hover { border-color: var(--link); color: var(--link); }
  .counts { display: flex; flex-wrap: wrap; gap: 12px 16px; margin: 14px 0 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; }
  .count { font-weight: 650; }
  .kind-added { color: var(--added); }
  .kind-changed { color: var(--changed); }
  .kind-removed, .kind-failed { color: var(--removed); }
  .kind-moved, .kind-shared { color: var(--moved); }
  article.row { margin-top: 10px; border-radius: 12px; padding: 10px 12px 10px 14px; border: 1px solid transparent; border-left-width: 4px; }
  article.kind-added { background: var(--added-bg); border-left-color: var(--added); }
  article.kind-changed { background: var(--changed-bg); border-left-color: var(--changed); }
  article.kind-removed, article.kind-failed { background: var(--removed-bg); border-left-color: var(--removed); }
  article.kind-moved, article.kind-shared { background: var(--moved-bg); border-left-color: var(--moved); }
  article.kind-not_found { background: var(--missing-bg); border-left: 4px dashed var(--missing); }
  article.kind-not_checked { background: var(--unchecked-bg); border-left: 4px dashed var(--unchecked); }
  article.kind-read { background: transparent; border-left-color: var(--line); }
  .head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .kind { font-weight: 700; }
  article.kind-added .kind { color: var(--added); }
  article.kind-changed .kind { color: var(--changed); }
  article.kind-removed .kind, article.kind-failed .kind { color: var(--removed); }
  article.kind-moved .kind, article.kind-shared .kind { color: var(--moved); }
  article.kind-not_found .kind { color: var(--missing); }
  article.kind-not_checked .kind { color: var(--unchecked); }
  article.kind-read .kind { color: var(--muted); }
  h3.repo { margin: 16px 0 0; color: var(--muted); font-size: 13px; font-weight: 650; }
  .svc, .who { color: var(--muted); }
  .tag { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 13px; }
  .tag svg { width: 14px; height: 14px; }
  article.kind-added .tag.verified { color: var(--added); }
  .body { margin: 4px 0 0; }
  details.undo { margin-left: auto; }
  details.undo > summary { color: var(--link); cursor: pointer; list-style: none; font-weight: 650; }
  details.undo > summary::-webkit-details-marker { display: none; }
  .panel { margin-top: 8px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
  textarea.prompt { width: 100%; min-height: 72px; border: 0; resize: vertical; background: transparent; color: var(--ink); font: inherit; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  button.copy, a.deeplink { background: transparent; color: var(--link); border: 0; padding: 0; font: inherit; font-weight: 650; cursor: pointer; text-decoration: none; }
  footer, .empty { color: var(--muted); }
  footer { margin: 16px 4px 0; font-size: 14px; }
  details.notes { margin-top: 14px; color: var(--muted); font-size: 13px; }
  details.notes summary { cursor: pointer; }
  a { color: var(--link); }
  @media (max-width: 640px) {
    main { margin-top: 12px; }
    h1 { font-size: 20px; }
    .card { padding: 16px 14px 12px; }
  }
</style>
</head>
<body>
<main>
  <section class="card">
    <p class="eyebrow">${escapeHtml(input.eyebrow)}</p>
    <h1>${escapeHtml(heading)}</h1>
    ${undoButton}
    ${chipHtml ? `<p class="counts">${chipHtml}</p>` : ""}
    ${body}
    ${footer ? `<footer>${escapeHtml(footer)}</footer>` : ""}
    ${input.footerNote ? `<footer>${escapeHtml(input.footerNote)}</footer>` : ""}
    ${notes ? `<details class="notes"><summary>How to read this</summary>${notes}</details>` : ""}
  </section>
</main>
<script>
document.addEventListener("click", function (event) {
  var target = event.target;
  if (!target || !target.closest) return;
  var button = target.closest("button.copy");
  if (!button) return;
  var panel = button.closest(".panel");
  var box = panel ? panel.querySelector("textarea") : null;
  var text = box ? box.value : "";
  var done = function () { button.textContent = "Copied"; };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done);
  else done();
});
</script>
</body>
</html>`;
}

export function renderUndoPage(input: { receiptId: string; plans: { changeId: string; prompt: string; summary: string; service: string; daysLeft?: number }[] }): string {
  const lines: StoryLine[] = input.plans.map((plan) => ({
    service: plan.service,
    source: "claim",
    write: true,
    tone: "changed",
    summary: plan.prompt,
    seed: plan.changeId,
    undo: plan.prompt,
    id: plan.changeId,
    ...(plan.daysLeft ? { undoDaysLeft: plan.daysLeft } : {}),
  }));
  return renderDiffPage({
    title: `Undo · ${input.receiptId}`,
    eyebrow: "UNDO",
    lines,
    receiptId: input.receiptId,
    notes: ["An undo prompt is an instruction. Life Diff does not change the account until an agent runs it. The next receipt shows the reverse change only after the agent does it."],
    footerNote: input.plans.length === 0 ? "Nothing on this receipt can be undone." : undefined,
  });
}

function renderGrouped(lines: StoryLine[], showClient: boolean, receiptId?: string): string {
  if (lines.length === 0) return `<p class="empty">No changes.</p>`;
  const services = new Map<string, StoryLine[]>();
  for (const line of lines) {
    const list = services.get(line.service) ?? [];
    list.push(line);
    services.set(line.service, list);
  }
  const sections: string[] = [];
  for (const groupLines of services.values()) {
    for (const group of repoGroups(groupLines)) {
      const heading = group.heading ? `<h3 class="repo">${escapeHtml(group.heading)}</h3>` : "";
      sections.push(`${heading}${group.lines.map((line) => renderRow(line, showClient, receiptId)).join("")}`);
    }
  }
  return sections.join("");
}

function renderRow(line: StoryLine, showClient: boolean, receiptId?: string): string {
  const tone = displayTone(line);
  const kind = tone === "not_found" ? "not_found" : tone === "not_checked" ? "not_checked" : tone === "failed" ? "failed" : tone === "created" ? "added" : tone;
  const symbol = markerFor(tone);
  const label = kindName(tone);
  const service = shortService(line.service);
  const trust = tone === "failed" || tone === "read" ? "" : (line.trust ?? trustLabel(line.source, line.service));
  const trustHtml = trust
    ? `<span class="tag${trust === "Verified" ? " verified" : ""}">${trust === "Verified" ? CHECK : ""}${escapeHtml(trust)}</span>`
    : "";
  const who = showClient && line.client ? `<span class="who">${escapeHtml(line.client)}</span>` : "";
  const headLabel = tone === "failed"
    ? `Failed`
    : tone === "not_found"
      ? `? Not found`
      : tone === "not_checked"
        ? `Not checked`
        : tone === "read"
          ? `Lookup`
          : `${symbol} ${label}`;
  const serviceHtml = tone === "not_found" || tone === "not_checked" ? "" : `<span class="svc">${escapeHtml(service)}</span>`;
  const undo = line.undo && line.id ? renderUndo(line, receiptId) : "";
  const open = line.link?.startsWith("https://") ? ` <a href="${escapeHtml(line.link)}">Open</a>` : "";
  return `<article class="row kind-${kind}">
    <div class="head"><span class="kind">${escapeHtml(headLabel)}</span>${serviceHtml}${trustHtml}${who}${undo}</div>
    <p class="body">${escapeHtml(rowBody(line))}${open}</p>
  </article>`;
}

function renderUndo(line: StoryLine, receiptId?: string): string {
  const href = receiptId && line.id ? `/receipts/${encodeURIComponent(receiptId)}/undo/${encodeURIComponent(line.id)}` : "";
  const deep = line.client && /cursor/i.test(line.client) && line.undo
    ? `<a class="deeplink" href="${escapeHtml(`https://cursor.com/link/prompt?text=${encodeURIComponent(line.undo)}`)}">Open in Cursor</a>`
    : "";
  const pageLink = href ? `<a href="${escapeHtml(href)}">Open undo prompt</a>` : "";
  return `<details class="undo">
    <summary>${escapeHtml(undoLabel(line.undoDaysLeft))}</summary>
    <div class="panel">
      <textarea class="prompt" readonly>${escapeHtml(line.undo ?? "")}</textarea>
      <div class="actions"><button type="button" class="copy">Copy undo prompt</button>${pageLink}${deep}</div>
    </div>
  </details>`;
}
