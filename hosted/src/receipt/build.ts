import { HOSTED_VERSION, PRODUCER_NAME, SCHEMA_VERSION } from "../constants";
import { diffGitHub } from "../github/diff";
import type { AfterRead, GitHubSnapshot } from "../github/types";
import type { ClaimInput, Counts, Receipt, RecordedAction } from "./types";
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

export function buildActionReceipt(input: {
  receiptId: string;
  startedAt: string;
  checkedAt: string;
  timeZone: string;
  actions: RecordedAction[];
}): Receipt {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.receiptId,
    generatedAt: input.checkedAt,
    readOnly: true,
    producer: { name: PRODUCER_NAME, version: HOSTED_VERSION },
    snapshot: { id: "none", takenAt: input.startedAt },
    comparedAt: input.checkedAt,
    timeZone: input.timeZone,
    session: { startedAt: input.startedAt, checkedAt: input.checkedAt },
    github: {
      repos: [],
      diffMode: "snapshot",
      truncatedSnapshot: false,
      truncatedChanges: false,
      suppressedRemovals: false,
    },
    counts: countChanges([], [], false),
    changes: [],
    claimsChecked: false,
    claims: [],
    actions: input.actions,
    notes: [
      "This receipt lists tool calls Life Diff forwarded. Each one is marked reported by the proxy.",
      "A proxied call is not proof the service changed. Verified lines come from a service that exposes history, such as GitHub.",
      "Life Diff did not run a GitHub snapshot for this session, so there is no verified GitHub diff.",
      `Times are shown in ${input.timeZone}.`,
    ],
  };
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
  for (const action of receipt.actions ?? []) lines.push(action.summary);
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
