import { fold } from "../text";
import { confidenceReason } from "./confidence";
import { displayName, serviceFromTool, toolMentioned } from "./names";
import type { Change, ClaimAction, ClaimInput, ClaimResult, ClaimStatus } from "./types";

interface NormalizedClaim {
  raw: ClaimInput;
  service: string;
  resourceType: string;
  action: ClaimAction | "";
  anyKind: boolean;
  badAction: boolean;
  repo: string;
}

export function normalizeAction(action: string): ClaimAction | null {
  switch (fold(action)) {
    case "add":
    case "added":
    case "create":
    case "created":
    case "new":
    case "open":
    case "opened":
      return "added";
    case "remove":
    case "removed":
    case "delete":
    case "deleted":
    case "trash":
    case "trashed":
    case "close":
    case "closed":
      return "removed";
    case "move":
    case "moved":
    case "rename":
    case "renamed":
      return "moved";
    case "share":
    case "shared":
      return "shared";
    case "modify":
    case "modified":
    case "update":
    case "updated":
    case "change":
    case "changed":
    case "edit":
    case "edited":
      return "modified";
    default:
      return null;
  }
}

/** moved and shared still match a modified resource. Older receipts stored those verbs as modified. */
export function actionsMatch(action: ClaimAction | "", kind: Change["kind"]): boolean {
  if (!action) return true;
  if (action === kind) return true;
  return (action === "moved" || action === "shared") && kind === "modified";
}

export function applyClaims(changes: Change[], inputs: ClaimInput[] | null): { changes: Change[]; claims: ClaimResult[] } {
  const next = changes.map((change) => ({ ...change }));
  if (inputs === null) {
    return { changes: next, claims: [] };
  }
  const claims = inputs.map((input) => normalizeClaim(input));
  const pairs: { ci: number; chi: number; score: number }[] = [];
  for (let ci = 0; ci < claims.length; ci += 1) {
    const claim = claims[ci];
    if (!claim || fold(claim.raw.target) === "") continue;
    for (let chi = 0; chi < next.length; chi += 1) {
      const change = next[chi];
      if (!change) continue;
      const score = scoreClaim(claim, change);
      if (score > 0) pairs.push({ ci, chi, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.ci - b.ci || a.chi - b.chi);
  const usedClaim = new Set<number>();
  const usedChange = new Set<number>();
  const match = new Map<number, number>();
  for (const pair of pairs) {
    if (usedClaim.has(pair.ci) || usedChange.has(pair.chi)) continue;
    usedClaim.add(pair.ci);
    usedChange.add(pair.chi);
    match.set(pair.ci, pair.chi);
  }
  const results: ClaimResult[] = [];
  for (let i = 0; i < claims.length; i += 1) {
    const claim = claims[i];
    if (!claim) continue;
    const id = claim.raw.id?.trim() || `claim-${i + 1}`;
    const result: ClaimResult = {
      id,
      target: claim.raw.target,
      status: "missing",
      reason: missingReason(claim),
    };
    if (claim.service) result.service = claim.service;
    if (!claim.anyKind && claim.action) result.action = claim.action;
    if (claim.raw.detail) result.detail = claim.raw.detail;
    if (claim.resourceType) result.resource = claim.resourceType;
    if (claim.repo) result.repo = claim.repo;
    if (claim.raw.before) result.before = claim.raw.before;
    if (claim.raw.after) result.after = claim.raw.after;
    if (claim.raw.url) result.url = claim.raw.url;
    const chi = match.get(i);
    if (chi !== undefined) {
      const change = next[chi];
      if (change) {
        result.status = "verified";
        result.matchedChangeIds = [change.id];
        result.confidence = change.confidence;
        result.reason = verifiedReason(change);
        change.claimStatus = "verified";
      }
    }
    results.push(result);
  }
  for (const change of next) {
    if (!change.claimStatus) change.claimStatus = "unclaimed" satisfies ClaimStatus;
  }
  return { changes: next, claims: results };
}

function normalizeClaim(raw: ClaimInput): NormalizedClaim {
  const out: NormalizedClaim = {
    raw,
    service: "",
    resourceType: "",
    action: "",
    anyKind: true,
    badAction: false,
    repo: fold(raw.repo ?? ""),
  };
  const service = fold(raw.service ?? "");
  if (service) {
    const mapped = mapService(service);
    out.service = mapped.service;
    out.resourceType = mapped.resourceType;
  }
  if (raw.action && raw.action.trim()) {
    const action = normalizeAction(raw.action);
    if (action) {
      out.action = action;
      out.anyKind = false;
    } else {
      out.badAction = true;
      out.anyKind = false;
    }
  }
  return out;
}

/** True when this claim names GitHub or a GitHub resource Life Diff can check. */
export function isGitHubClaimService(service: string | undefined): boolean {
  if (!service?.trim()) return false;
  return mapService(fold(service)).service === "github";
}

/**
 * Brand name for a stored claim. A tool mentioned in the detail wins over a
 * service that was defaulted to GitHub before the tool was known.
 */
export function serviceForClaim(claim: { service?: string; detail?: string }): string {
  const tool = toolMentioned(claim.detail);
  if (tool) {
    const derived = serviceFromTool(tool);
    if (derived.key !== "github") return derived.display;
    return "GitHub";
  }
  if (claim.service) {
    if (isGitHubClaimService(claim.service)) return "GitHub";
    return displayName(claim.service);
  }
  return "Service";
}

function mapService(service: string): { service: string; resourceType: string } {
  switch (service) {
    case "github":
    case "gh":
      return { service: "github", resourceType: "" };
    case "pull":
    case "pr":
    case "pull_request":
    case "pullrequest":
      return { service: "github", resourceType: "pull_request" };
    case "issue":
    case "issues":
      return { service: "github", resourceType: "issue" };
    case "commit":
    case "commits":
      return { service: "github", resourceType: "commit" };
    case "branch":
    case "branches":
      return { service: "github", resourceType: "branch" };
    case "comment":
    case "comments":
      return { service: "github", resourceType: "comment" };
    case "file":
    case "files":
      return { service: "github", resourceType: "file" };
    case "label":
    case "labels":
      return { service: "github", resourceType: "label" };
    default:
      return { service, resourceType: "" };
  }
}

function scoreClaim(claim: NormalizedClaim, change: Change): number {
  if (claim.badAction) return 0;
  if (claim.service && claim.service !== change.service) return 0;
  if (claim.repo && fold(change.repo) !== claim.repo) return 0;
  if (claim.resourceType === "label") {
    if (!change.labelsChanged) return 0;
  } else if (claim.resourceType && claim.resourceType !== change.resourceType) {
    return 0;
  }
  if (!claim.anyKind && !actionsMatch(claim.action, change.kind)) return 0;
  const target = fold(claim.raw.target);
  if (!target) return 0;
  let score = 0;
  if (claim.raw.target === change.resourceId) score = 12;
  else if (target === fold(change.resourceName)) score = 10;
  else if (phraseIn(change.resourceName, claim.raw.target) || phraseIn(claim.raw.target, change.resourceName)) score = 6;
  else return 0;
  if (claim.raw.detail && phraseIn(change.summary, claim.raw.detail)) score += 2;
  return score;
}

function phraseIn(hay: string, needle: string): boolean {
  const h = fold(hay);
  const n = fold(needle);
  if ([...n].length < 3) return false;
  if (h === n) return true;
  return ` ${h} `.includes(` ${n} `);
}

function verifiedReason(change: Change): string {
  let reason = `This matches a GitHub change to ${JSON.stringify(change.resourceName)}.`;
  if (change.confidence === "low") {
    reason += " GitHub dates that change before the snapshot, so this check is less sure the agent did it.";
  }
  return reason;
}

function missingReason(claim: NormalizedClaim): string {
  if (claim.service && claim.service !== "github") {
    return `No matching change showed up for ${claim.raw.service ?? claim.service}.`;
  }
  if (claim.badAction) {
    return `The action ${JSON.stringify(claim.raw.action)} is not one Life Diff can check.`;
  }
  return "No matching change showed up in GitHub.";
}

export function confidenceLabel(level: Change["confidence"]): string {
  switch (level) {
    case "high":
      return "High confidence";
    case "medium":
      return "Medium confidence";
    case "low":
      return "Low confidence";
    default: {
      const never: never = level;
      return confidenceReason(never);
    }
  }
}
