import { escapeHtml, formatInstant } from "../text";
import { renderDiffPage } from "./page";
import { condenseLines, headlineFor, storyFromReceipt } from "./story";
import type { ClaimResult, Receipt } from "./types";

const ICON_VERIFIED = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.2l3.2 3.2 7.3-7.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
const ICON_MISSING = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.8"/></svg>`;

export function renderHtml(receipt: Receipt): string {
  const lines = condenseLines(storyFromReceipt(receipt), { detail: false });
  const session = `Snapshot ${formatInstant(receipt.session.startedAt, receipt.timeZone)} · checked ${formatInstant(receipt.session.checkedAt, receipt.timeZone)}`;
  const repos = receipt.github.repos.length > 0 ? ` Repositories: ${receipt.github.repos.join(", ")}.` : "";
  return renderDiffPage({
    title: `Life Diff receipt ${receipt.id}`,
    lede: `One receipt of what changed.${repos}`,
    headline: headlineFor(lines, "This session"),
    when: session,
    lines,
    notes: receipt.notes,
    extra: `${renderClaims(receipt)}${renderWarnings(receipt)}`,
    footer: `Receipt ${receipt.id} · schema 1.0.0 · Life Diff did not change any GitHub data.`,
  });
}

function renderClaims(receipt: Receipt): string {
  if (!receipt.claimsChecked) return "";
  const body = receipt.claims.length === 0
    ? `<p class="empty">The agent claimed that nothing changed.</p>`
    : receipt.claims.map(renderClaim).join("");
  return `<section class="claims"><h2>What the agent said</h2><p class="source">A claim is verified when GitHub shows a matching change.</p>${body}</section>`;
}

function renderClaim(claim: ClaimResult): string {
  const verified = claim.status === "verified";
  const title = `${verified ? "Verified" : "Missing"} ${JSON.stringify(claim.target)} in GitHub${claim.action ? ` (${claim.action})` : ""}`;
  return `<article class="row is-${verified ? "created" : "changed"}">
      <p class="summary">${verified ? ICON_VERIFIED : ICON_MISSING} ${escapeHtml(title)}</p>
      ${claim.detail ? `<p>${escapeHtml(claim.detail)}</p>` : ""}
      <p class="source">${escapeHtml(claim.reason)}</p>
    </article>`;
}

function renderWarnings(receipt: Receipt): string {
  if (!receipt.warnings || receipt.warnings.length === 0) return "";
  return `<section><h2>Check notes</h2>${receipt.warnings.map((warning) => `<p class="note">${escapeHtml(warning)}</p>`).join("")}</section>`;
}
