import { normalizeAction, serviceForClaim } from "./claims";
import { displayName } from "./names";
import type { ClaimResult, RecordedAction } from "./types";

/** Compare titles ignoring case, quotes, and trailing punctuation. */
export function normalizeTitle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^['"“”‘’]+|['"“”‘’]+$/g, "")
    .replace(/^(the|a|an)\s+/g, "")
    .replace(/[.…,:;!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Claim ids that describe a logged or proxied action already on the receipt.
 * Those claims stay on the matching row instead of a second Not checked line.
 */
export function coveredClaimIds(actions: RecordedAction[], claims: ClaimResult[]): Set<string> {
  const ownIds = new Set(actions.map((action) => action.id));
  const used = new Set<string>();
  const covered = new Set<string>();
  for (const claim of claims) {
    if (!claim.id || claim.action === "read" || ownIds.has(claim.id)) continue;
    const match = actions.find((action) => !used.has(action.id) && actionMatchesClaim(action, claim));
    if (!match) continue;
    used.add(match.id);
    covered.add(claim.id);
  }
  return covered;
}

export function undoDedupeKey(line: { service: string; tone: string; repo?: string; summary: string }): string {
  return [serviceKey(line.service), line.tone, line.repo ?? "", normalizeTitle(line.summary)].join("\0");
}

function actionMatchesClaim(action: RecordedAction, claim: ClaimResult): boolean {
  if (action.ok === false || action.effect === "read" || action.tone === "read") return false;
  const claimKind = claim.action ? normalizeAction(claim.action) ?? "" : "";
  const actionKind = kindOfTone(action.tone);
  if (!claimKind || !actionKind || claimKind !== actionKind) return false;
  if (serviceKey(serviceForClaim(claim)) !== serviceKey(action.upstream || action.tool)) return false;
  const wanted = normalizeTitle(claim.target);
  if (!wanted) return false;
  return titlesOf(action).some((title) => titlesMatch(wanted, normalizeTitle(title)));
}

function titlesMatch(claimTitle: string, actionTitle: string): boolean {
  if (!actionTitle) return false;
  if (claimTitle === actionTitle) return true;
  if (claimTitle.length < 3 || actionTitle.length < 3) return false;
  return phraseHas(actionTitle, claimTitle) || phraseHas(claimTitle, actionTitle);
}

function phraseHas(hay: string, needle: string): boolean {
  return ` ${hay} `.includes(` ${needle} `);
}

function titlesOf(action: RecordedAction): string[] {
  const titles = [action.summary];
  const record = action.arguments && typeof action.arguments === "object" && !Array.isArray(action.arguments)
    ? action.arguments as Record<string, unknown>
    : undefined;
  for (const key of ["subject", "title", "name", "summary"]) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) titles.push(value);
  }
  return titles;
}

function kindOfTone(tone: string | undefined): string {
  switch (tone) {
    case "created":
      return "added";
    case "changed":
      return "modified";
    case "removed":
      return "removed";
    case "moved":
      return "moved";
    case "shared":
      return "shared";
    default:
      return "";
  }
}

function serviceKey(name: string): string {
  const full = displayName(name);
  if (full === "Google Calendar" || full === "Calendar") return "calendar";
  if (full === "Google Drive" || full === "Drive") return "drive";
  return full.toLowerCase().replace(/[^a-z0-9]/g, "");
}
