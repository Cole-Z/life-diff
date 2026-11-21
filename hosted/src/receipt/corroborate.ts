import type { LoggedAction } from "../session/book";
import { fold } from "../text";
import { recordedFrom } from "./actions";
import type { ClaimResult, Receipt, RecordedAction } from "./types";

/**
 * Drop a stored read claim that was saved beside the proxied read it describes.
 * Older receipts stored that claim with source `proxy`, so it was counted twice.
 * Two real lookups of the same tool are left as they are.
 */
export function dedupeStoredReads(actions: RecordedAction[]): RecordedAction[] {
  const drop = new Set<string>();
  for (const action of actions) {
    if (!isStoredRead(action) || !loggedReadShape(action)) continue;
    const match = actions.find((other) => (
      other.id !== action.id
      && !drop.has(other.id)
      && isStoredRead(other)
      && !loggedReadShape(other)
      && sameUpstream(action, other)
      && readOverlaps(action, other)
    ));
    if (match) drop.add(action.id);
  }
  if (drop.size === 0) return actions;
  return actions.filter((action) => !drop.has(action.id));
}

function isStoredRead(action: RecordedAction): boolean {
  return action.effect === "read" || action.tone === "read";
}

function loggedReadShape(action: RecordedAction): boolean {
  if (action.source === "claim") return true;
  if (fold(action.tool) !== "" && fold(action.tool) === fold(action.upstream)) return true;
  if (!action.arguments || typeof action.arguments !== "object" || Array.isArray(action.arguments)) return false;
  const keys = Object.keys(action.arguments as Record<string, unknown>);
  return keys.length > 0 && keys.every((key) => key === "subject" || key === "target");
}

function sameUpstream(left: RecordedAction, right: RecordedAction): boolean {
  return compact(left.upstream) !== "" && compact(left.upstream) === compact(right.upstream);
}

function readOverlaps(claim: RecordedAction, other: RecordedAction): boolean {
  const hay = fold(`${other.summary} ${JSON.stringify(other.arguments ?? {})}`);
  const subject = readSubject(claim);
  if (subject && fold(subject).length >= 3 && hay.includes(fold(subject))) return true;
  const repos = fold(`${claim.summary} ${JSON.stringify(claim.arguments ?? {})}`).match(/[a-z0-9_.-]+\/[a-z0-9_.-]+/g) ?? [];
  return repos.length > 0 && repos.every((repo) => hay.includes(repo));
}

function readSubject(action: RecordedAction): string | undefined {
  if (action.arguments && typeof action.arguments === "object" && !Array.isArray(action.arguments)) {
    const subject = (action.arguments as Record<string, unknown>).subject;
    if (typeof subject === "string" && subject.trim()) return subject;
  }
  return action.summary;
}

type Kind = "read" | "added" | "removed" | "modified";

const STOP = new Set([
  "wiki", "structure", "contents", "content", "docs", "outline", "lookup", "looked",
  "read", "the", "and", "for", "from", "with", "about", "something", "page", "pages",
  "question", "asked", "call", "tool", "action", "session", "this", "that", "into", "onto",
]);

export interface CorroboratedLog {
  recorded: RecordedAction[];
  readClaims: ClaimResult[];
  /** Claim ids folded into a proxied call, including writes, so they are not shown again. */
  foldedClaimIds: string[];
}

/**
 * Fold a log_action claim into a proxied call from the same session when the
 * service, the kind of action, and the target line up. The claim stays in
 * `readClaims` and is not counted again. Unmatched claims stay in `recorded`.
 */
export function corroborateActions(actions: LoggedAction[]): CorroboratedLog {
  const claimIndexes: number[] = [];
  const proxyIndexes: number[] = [];
  actions.forEach((action, index) => {
    if (action.source === "proxy") proxyIndexes.push(index);
    else claimIndexes.push(index);
  });
  const pairs: { claim: number; proxy: number; score: number }[] = [];
  for (const ci of claimIndexes) {
    const claim = actions[ci];
    if (!claim) continue;
    const kind = claimKind(claim);
    if (!kind) continue;
    for (const pi of proxyIndexes) {
      const proxy = actions[pi];
      if (!proxy || proxyKind(proxy) !== kind || !sameService(claim, proxy)) continue;
      const score = scoreTarget(claim, proxy);
      if (score > 0) pairs.push({ claim: ci, proxy: pi, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.claim - b.claim || a.proxy - b.proxy);
  const matchedClaims = new Set<number>();
  const corroboratedProxies = new Set<number>();
  const claimToProxy = new Map<number, number>();
  for (const pair of pairs) {
    if (matchedClaims.has(pair.claim) || corroboratedProxies.has(pair.proxy)) continue;
    matchedClaims.add(pair.claim);
    corroboratedProxies.add(pair.proxy);
    claimToProxy.set(pair.claim, pair.proxy);
  }
  const recorded: RecordedAction[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (!action || matchedClaims.has(index)) continue;
    const row = recordedFrom(action);
    if (!row) continue;
    recorded.push(corroboratedProxies.has(index) ? { ...row, corroborated: true } : row);
  }
  const readClaims: ClaimResult[] = [];
  const foldedClaimIds: string[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (!action) continue;
    if (matchedClaims.has(index)) foldedClaimIds.push(action.id);
    if (!isReadClaim(action)) continue;
    const proxyIndex = claimToProxy.get(index);
    readClaims.push(readClaimResult(action, proxyIndex === undefined ? undefined : actions[proxyIndex]));
  }
  return { recorded, readClaims, foldedClaimIds };
}

export function attachReadClaims(receipt: Receipt, reads: ClaimResult[]): void {
  if (reads.length === 0) return;
  let verified = 0;
  let missing = 0;
  for (const claim of reads) {
    if (claim.status === "verified") verified += 1;
    else missing += 1;
  }
  receipt.claimsChecked = true;
  receipt.claims = [...receipt.claims, ...reads];
  receipt.counts = {
    ...receipt.counts,
    verifiedClaims: receipt.counts.verifiedClaims + verified,
    missingClaims: receipt.counts.missingClaims + missing,
  };
}

function readClaimResult(action: LoggedAction, proxy: LoggedAction | undefined): ClaimResult {
  const claim: ClaimResult = {
    id: action.id,
    target: action.target,
    status: proxy ? "verified" : "missing",
    reason: proxy
      ? "This matches a call Life Diff saw in this session."
      : "Life Diff did not forward a matching call. This lookup is counted as the agent reported it.",
    service: action.upstream || action.tool,
    action: "read",
    ...(action.detail ? { detail: action.detail } : {}),
    ...(proxy ? { corroborated: true, matchedActionId: proxy.id } : {}),
  };
  return claim;
}

function isReadClaim(action: LoggedAction): boolean {
  return action.source !== "proxy" && claimKind(action) === "read";
}

function claimKind(action: LoggedAction): Kind | null {
  switch (action.action) {
    case "read":
      return "read";
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "modified":
      return "modified";
    default:
      break;
  }
  if (action.effect === "read" || action.tone === "read") return "read";
  if (action.tone === "created") return "added";
  if (action.tone === "removed") return "removed";
  if (action.tone === "changed") return "modified";
  return null;
}

function proxyKind(action: LoggedAction): Kind {
  if (action.effect === "write" || action.tone === "created" || action.tone === "changed" || action.tone === "removed") {
    if (action.tone === "created") return "added";
    if (action.tone === "removed") return "removed";
    return "modified";
  }
  return "read";
}

function sameService(claim: LoggedAction, proxy: LoggedAction): boolean {
  const claimService = compact(claim.upstream || claim.tool);
  const proxyService = compact(proxy.upstream || "");
  if (claimService && proxyService && claimService === proxyService) return true;
  const claimTool = fold(claim.tool);
  const proxyTool = fold(proxy.tool);
  if (claimTool && proxyTool && claimTool === proxyTool) return true;
  return Boolean(claimTool && proxyService && compact(claimTool) === proxyService);
}

function scoreTarget(claim: LoggedAction, proxy: LoggedAction): number {
  const target = fold(claim.target);
  const hay = haystack(proxy);
  if (target.length < 3 || !hay) return 0;
  let score = 0;
  if (hay.includes(target)) score += 8;
  const repos = target.match(/[a-z0-9_.-]+\/[a-z0-9_.-]+/g) ?? [];
  if (repos.length > 0) {
    if (!repos.every((repo) => hay.includes(repo))) return 0;
    score += 6;
  }
  const words = target.split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !STOP.has(word));
  const hits = words.filter((word) => containsTerm(hay, word));
  if (repos.length === 0 && !hay.includes(target) && hits.length === 0) return 0;
  score += hits.length;
  const tool = fold(proxy.tool);
  if (target.includes("structure") && tool.includes("structure")) score += 3;
  if (target.includes("content") && tool.includes("content")) score += 3;
  if ((target.includes("question") || target.includes("asked")) && (tool.includes("ask") || tool.includes("question"))) score += 3;
  return score;
}

function haystack(action: LoggedAction): string {
  const bits = [action.target, action.summary ?? "", action.tool, action.upstream ?? ""];
  if (action.arguments !== undefined) {
    try {
      bits.push(JSON.stringify(action.arguments));
    } catch {
      // Arguments that cannot be serialized do not help a match.
    }
  }
  return fold(bits.join(" "));
}

function containsTerm(hay: string, term: string): boolean {
  if (term.includes("/") || term.length >= 8) return hay.includes(term);
  return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(hay);
}

function compact(value: string): string {
  return fold(value).replace(/[^a-z0-9]/g, "");
}
