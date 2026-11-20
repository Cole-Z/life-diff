import { HOSTED_VERSION, PRODUCER_NAME, SCHEMA_VERSION } from "../constants";
import { diffGitHub } from "../github/diff";
import type { AfterRead, GitHubSnapshot } from "../github/types";
import type { ClaimInput, Counts, Receipt } from "./types";
import { applyClaims } from "./claims";

export function buildReceipt(input: {
  receiptId: string;
  before: GitHubSnapshot;
  after: AfterRead;
  checkedAt: string;
  timeZone: string;
  claims: ClaimInput[] | null;
}): Receipt {
  const diff = diffGitHub(input.before, input.after, input.checkedAt);
  const applied = input.claims === null
    ? { changes: diff.changes, claims: [] }
    : applyClaims(diff.changes, input.claims);
  const counts = countChanges(applied.changes, applied.claims, input.claims !== null);
  const warnings = [...input.before.warnings, ...diff.warnings];
  const receipt: Receipt = {
    schemaVersion: SCHEMA_VERSION,
    id: input.receiptId,
    generatedAt: input.checkedAt,
    readOnly: true,
    producer: { name: PRODUCER_NAME, version: HOSTED_VERSION },
    snapshot: { id: input.before.id, takenAt: input.before.takenAt },
    comparedAt: input.checkedAt,
    timeZone: input.timeZone,
    session: { startedAt: input.before.takenAt, checkedAt: input.checkedAt },
    github: {
      repos: diff.repos,
      diffMode: "snapshot",
      truncatedSnapshot: diff.truncatedSnapshot,
      truncatedChanges: diff.truncatedChanges,
      suppressedRemovals: diff.suppressedRemovals,
    },
    counts,
    changes: applied.changes,
    claimsChecked: input.claims !== null,
    claims: applied.claims,
    notes: [
      "This receipt is from GitHub's records, not from what the agent said.",
      "Life Diff only read data. It did not change GitHub.",
      "File bodies are not stored. A file change lists the path and a short size summary.",
      "Claimed actions are what an agent logged through Life Diff. Verified means GitHub shows a matching change.",
      `Times are shown in ${input.timeZone}.`,
    ],
  };
  if (warnings.length > 0) receipt.warnings = [...new Set(warnings)];
  return receipt;
}

function countChanges(changes: Receipt["changes"], claims: Receipt["claims"], checked: boolean): Counts {
  const counts: Counts = {
    added: 0,
    removed: 0,
    modified: 0,
    verifiedClaims: 0,
    missingClaims: 0,
    unclaimedChanges: 0,
  };
  for (const change of changes) {
    if (change.kind === "added") counts.added += 1;
    else if (change.kind === "removed") counts.removed += 1;
    else counts.modified += 1;
    if (checked && change.claimStatus === "unclaimed") counts.unclaimedChanges += 1;
  }
  if (checked) {
    for (const claim of claims) {
      if (claim.status === "verified") counts.verifiedClaims += 1;
      else counts.missingClaims += 1;
    }
  }
  return counts;
}

export function plainSummary(receipt: Receipt): string {
  const lines = [`${receipt.counts.added} added, ${receipt.counts.removed} removed, ${receipt.counts.modified} modified`];
  for (const change of receipt.changes) {
    lines.push(`${kindLabel(change.kind)} (GitHub): ${change.summary}`);
  }
  if (receipt.claimsChecked) {
    lines.push(`Claims: ${receipt.counts.verifiedClaims} verified, ${receipt.counts.missingClaims} missing`);
    for (const claim of receipt.claims) {
      if (claim.status === "missing") lines.push(`Missing: ${claim.target}. ${claim.reason}`);
    }
  }
  return lines.join("\n");
}

function kindLabel(kind: Receipt["changes"][number]["kind"]): string {
  switch (kind) {
    case "added":
      return "Added";
    case "removed":
      return "Removed";
    case "modified":
      return "Modified";
    default: {
      const never: never = kind;
      return never;
    }
  }
}
