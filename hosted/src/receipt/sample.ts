import { buildActionReceipt } from "./build";
import { renderReceiptCard } from "./page";
import { condenseLines, storyFromReceipt } from "./story";
import type { Receipt, RecordedAction } from "./types";

const startedAt = "2026-11-20T15:02:00.000Z";
const checkedAt = "2026-11-20T15:18:00.000Z";
const repo = "example-org/launch-sandbox";

export const sampleNotes = [
  "Verified means Life Diff independently corroborated the change. Agent said means an agent reported it or Life Diff forwarded the call without independently checking the outcome.",
  "Not found means a check ran and found no match. Not checked means an independent check was unavailable. Failed means the call reported an error or the relay failed.",
];

const actions: RecordedAction[] = [
  {
    id: "ticket",
    upstream: "linear",
    tool: "update_issue",
    source: "proxy",
    effect: "write",
    verb: "update",
    tone: "changed",
    time: "2026-11-20T15:05:00.000Z",
    client: "QA agent",
    ok: true,
    status: "ok",
    summary: "Updated QA-42 · Smoke test for sign-in.",
    arguments: { title: "QA-42 · Sign-in smoke test marked Passed", status: "Passed" },
  },
  {
    id: "failed",
    upstream: "linear",
    tool: "update_issue",
    source: "proxy",
    effect: "write",
    verb: "update",
    tone: "changed",
    time: "2026-11-20T15:06:00.000Z",
    client: "QA agent",
    ok: false,
    status: "error",
    summary: "Tried to update QA-43.",
    arguments: { title: "QA-43 · Safari follow-up" },
    error: "QA-43 update rejected. Invalid status.",
  },
  {
    id: "meeting",
    upstream: "google_calendar",
    tool: "update_event",
    source: "claim",
    effect: "write",
    verb: "move",
    tone: "moved",
    time: "2026-11-20T15:09:00.000Z",
    client: "Planning agent",
    ok: true,
    status: "ok",
    summary: "Release readiness review",
    arguments: { title: "Release readiness review", before: "9:30 AM", after: "10:00 AM" },
  },
  {
    id: "lookup",
    upstream: "deepwiki",
    tool: "read_wiki_structure",
    source: "proxy",
    effect: "read",
    verb: "read",
    tone: "read",
    time: "2026-11-20T15:12:00.000Z",
    client: "QA agent",
    ok: true,
    status: "ok",
    summary: "Looked up the docs outline for facebook/react in DeepWiki.",
    arguments: { repoName: "facebook/react" },
  },
];

export const sampleReceipt: Receipt = {
  ...buildActionReceipt({ receiptId: "rcpt_sample", startedAt, checkedAt, timeZone: "America/Chicago", actions }),
  github: { repos: [repo], diffMode: "snapshot", truncatedSnapshot: false, truncatedChanges: false, suppressedRemovals: false, optIn: true },
  counts: { added: 1, removed: 0, modified: 0, verifiedClaims: 1, missingClaims: 0, unclaimedChanges: 0 },
  claimsChecked: true,
  claims: [{
    id: "claim-pr17", service: "github", action: "added", target: "Cover expired login links",
    repo, status: "verified", matchedChangeIds: ["pr17"], reason: "The PR matched the GitHub snapshot comparison.",
  }],
  notes: sampleNotes,
  changes: [{
    id: "pr17",
    service: "github",
    kind: "added",
    resourceId: `pull:${repo}:17`,
    resourceName: "Cover expired login links",
    summary: `Opened pull request "Cover expired login links" (#17) on ${repo}.`,
    fields: [{ field: "title", label: "Title", before: "", after: "Cover expired login links" }],
    confidence: "high",
    confidenceReason: "Opened during the session",
    claimStatus: "verified",
    resourceType: "pull_request",
    repo,
    occurredAt: "2026-11-20T15:15:00.000Z",
  }],
};

export function sampleLines() {
  return condenseLines(storyFromReceipt(sampleReceipt), { detail: false });
}

export function renderSampleCard(preview = false): string {
  const lines = sampleLines();
  const visible = preview ? lines.filter((line) => line.seed !== "ticket") : lines;
  return renderReceiptCard({
    eyebrow: "Sample session receipt",
    heading: preview ? "h2" : "h1",
    lines: visible,
    timeZone: sampleReceipt.timeZone,
    startedAt,
    endedAt: checkedAt,
    sample: true,
    ...(preview ? {} : { notes: sampleNotes }),
    footerNote: preview ? "Selected rows from a synthetic example." : "Synthetic fixture. These actions were not run on live accounts.",
  });
}
