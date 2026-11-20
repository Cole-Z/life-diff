import { HOSTED_VERSION, PRODUCER_NAME, SCHEMA_VERSION } from "../constants";
import { diffGitHub } from "../github/diff";
import type { AfterRead, GitHubSnapshot } from "../github/types";
import type { ClaimInput, Counts, Receipt, ReceiptAction } from "./types";
import { applyClaims } from "./claims";

export function buildReceipt(input: {
  receiptId: string;
  before: GitHubSnapshot;
  after: AfterRead;
  checkedAt: string;
  timeZone: string;
  claims: ClaimInput[] | null;
  actions?: ReceiptAction[];
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
    actions: input.actions ?? [],
    notes: [
      "Lines marked reported by the proxy are tool calls Life Diff forwarded. They are not proof the service changed.",
      "Lines marked verified from service history were read from GitHub. Life Diff did not change GitHub.",
      "A call only appears here when the agent sent it through Life Diff. A direct call to another server is invisible.",
      "Read or write is guessed from the tool name. Gray lines are lookups. Green, amber, and red lines are changes.",
      "File bodies are not stored. A GitHub file change lists the path and a short size summary.",
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

export function receiptForActions(input: {
  id: string;
  startedAt: string;
  checkedAt: string;
  timeZone: string;
  actions: ReceiptAction[];
  pendingGitHub: boolean;
}): Receipt {
  const receipt: Receipt = {
    schemaVersion: "1.0.0",
    id: input.id,
    generatedAt: input.checkedAt,
    readOnly: true,
    producer: { name: PRODUCER_NAME, version: HOSTED_VERSION },
    snapshot: { id: "open", takenAt: input.startedAt },
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
    counts: { added: 0, removed: 0, modified: 0, verifiedClaims: 0, missingClaims: 0, unclaimedChanges: 0 },
    changes: [],
    claimsChecked: false,
    claims: [],
    actions: input.actions,
    notes: [
      "This is the open session. It updates as tools are called. End the session to store a receipt.",
      "Lines marked reported by the proxy are tool calls Life Diff forwarded.",
      input.pendingGitHub
        ? "GitHub has not been compared yet. Call start_session, then end_session, for a verified diff."
        : "GitHub changes appear after end_session, labeled verified from service history.",
    ],
  };
  return receipt;
}

export function plainSummary(receipt: Receipt): string {
  const lines = [`${receipt.counts.added} added, ${receipt.counts.removed} removed, ${receipt.counts.modified} modified`];
  for (const change of receipt.changes) {
    lines.push(`${kindLabel(change.kind)} (GitHub): ${change.summary}`);
  }
  const actions = receipt.actions ?? [];
  if (actions.length > 0) {
    const writes = actions.filter((action) => action.tone !== "read");
    lines.push(`${actions.length} tool calls reported by the proxy (${writes.length} shown as changes or unknown)`);
    for (const action of writes) lines.push(action.summary);
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
