import { describe, expect, it } from "vitest";
import { endSession, recordProxyCall, sessionPortFromBook, startSession } from "../src/app/service";
import { renderCardPng } from "../src/receipt/card";
import { buildRoundup } from "../src/receipt/roundup";
import { renderStory, storyFromReceipt } from "../src/receipt/story";
import { undoHint } from "../src/receipt/undo";
import { SessionBook } from "../src/session/book";
import { MemoryMetadataStore, MemoryObjectStore } from "../src/storage/memory";
import type { GitHubApi } from "../src/github/types";
import type { Receipt } from "../src/receipt/types";

const now = new Date("2026-04-02T15:00:00.000Z");

describe("undo hints", () => {
  it("turns a create into a delete, and refuses to undo a send", () => {
    const created = undoHint({
      tool: "create_event",
      upstream: "google_calendar",
      verb: "create",
      tone: "created",
      effect: "write",
      summary: "Added “Standup” in Google calendar.",
      arguments: { title: "Standup" },
      result: '{"id":"evt_1"}',
    });
    expect(created).toBe("Undo: delete “Standup” (evt_1) via google_calendar__delete_event.");
    const sent = undoHint({
      tool: "send_message",
      upstream: "slack",
      verb: "send",
      tone: "removed",
      effect: "write",
      summary: "Sent “hi” from Slack.",
      arguments: { text: "hi", url: "https://slack.example/archives/C1" },
    });
    expect(sent).toContain("cannot auto-undo");
    expect(sent).toContain("https://slack.example/archives/C1");
    const updated = undoHint({
      tool: "update_event",
      upstream: "google_calendar",
      verb: "update",
      tone: "changed",
      effect: "write",
      summary: "Changed “Standup” in Google calendar.",
      arguments: { title: "Standup", previous: { title: "Daily" } },
    });
    expect(updated).toBe("Undo: restore title “Daily” via google_calendar__update_event.");
  });
});

describe("inline receipt", () => {
  it("renders markdown, a diff, and a png", async () => {
    const receipt = {
      schemaVersion: "1.0.0",
      id: "rcpt_test",
      generatedAt: now.toISOString(),
      readOnly: true,
      producer: { name: "lifediff-hosted", version: "0.1.0" },
      snapshot: { id: "snap", takenAt: now.toISOString() },
      comparedAt: now.toISOString(),
      timeZone: "UTC",
      session: { startedAt: now.toISOString(), checkedAt: now.toISOString() },
      github: { repos: ["acme/app"], diffMode: "snapshot", truncatedSnapshot: false, truncatedChanges: false, suppressedRemovals: false },
      counts: { added: 1, removed: 0, modified: 1, verifiedClaims: 0, missingClaims: 0, unclaimedChanges: 0 },
      claimsChecked: false,
      claims: [],
      notes: [],
      cardToken: "ab".repeat(16),
      actions: [{
        id: "act_1",
        time: now.toISOString(),
        upstream: "deepwiki",
        tool: "ask_wiki_question",
        summary: "Asked Deepwiki: “How does React work?”.",
        tone: "read",
        effect: "read",
        verb: "ask",
        ok: true,
        status: "ok",
        source: "proxy",
      }],
      changes: [{
        id: "chg_1",
        service: "github",
        kind: "modified",
        resourceId: "issue:acme/app:2",
        resourceName: "Bug",
        summary: "Closed issue “Bug” (#2) on acme/app.",
        fields: [{ field: "status", label: "Status", before: "open", after: "closed" }],
        confidence: "high",
        confidenceReason: "during the session",
        resourceType: "issue",
        repo: "acme/app",
        link: "https://github.com/acme/app/issues/2",
      }],
    } as Receipt;
    const lines = storyFromReceipt(receipt);
    const markdown = renderStory({
      title: "Life Diff receipt",
      lines,
      link: "https://lifediff.dev/receipts/rcpt_test",
      linkLabel: "Open the receipt",
      imageUrl: "https://lifediff.dev/receipts/rcpt_test/card.png?t=ab",
    });
    expect(markdown).toContain("🟡");
    expect(markdown).toContain("⚪");
    expect(markdown.indexOf("## GitHub")).toBeLessThan(markdown.indexOf("## deepwiki"));
    expect(markdown).toContain("```diff");
    expect(markdown).toContain("- Status: open");
    expect(markdown).toContain("+ Status: closed");
    expect(markdown).toContain("Undo: cannot auto-undo. https://github.com/acme/app/issues/2");
    expect(markdown.trim().endsWith("https://lifediff.dev/receipts/rcpt_test")).toBe(true);
    const png = await renderCardPng(lines, "Life Diff");
    expect(png[0]).toBe(137);
    expect(png[1]).toBe(80);
    expect(png[2]).toBe(78);
    expect(png[3]).toBe(71);
    const width = new DataView(png.buffer, png.byteOffset + 16, 4).getUint32(0);
    expect(width).toBe(720);
  });
});

describe("roundup", () => {
  it("merges sessions, keeps stable ids, and defaults to the last roundup", async () => {
    const book = new SessionBook();
    const meta = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    const deps = {
      userId: "42",
      login: "octocat",
      now,
      timeZone: "UTC",
      maxRepos: 25,
      receiptRetentionDays: 90,
      snapshotRetentionHours: 24,
      abandonedSessionDays: 7,
      sessions: sessionPortFromBook(book),
      meta,
      objects,
      github: quietGithub(),
      issuer: "https://lifediff.dev",
    };
    await startSession(deps, {});
    await recordProxyCall(deps, {
      upstream: "google_calendar",
      tool: "create_event",
      args: { title: "Standup" },
      ok: true,
      status: "ok",
      summary: "Added “Standup” in Google calendar.",
      classification: { effect: "write", tone: "created", verb: "create" },
      durationMs: 5,
      result: '{"id":"evt_1"}',
    });
    await endSession({ ...deps, now: new Date("2026-04-02T16:00:00.000Z") }, {});
    const first = await buildRoundup({ ...deps, now: new Date("2026-04-02T16:05:00.000Z") }, { save: true });
    expect(first.markdown).toContain("🟢");
    expect(first.markdown).toContain("google_calendar__delete_event");
    expect(first.markdown).toContain("evt_1");
    expect(first.imageUrl).toContain("/roundup/card.png?t=");
    expect(first.png[0]).toBe(137);
    const id = first.lines.find((line) => line.write)?.id;
    expect(id).toMatch(/^[a-z0-9]{2}$/);
    const second = await buildRoundup({ ...deps, now: new Date("2026-04-02T18:00:00.000Z") }, { save: true });
    expect(second.lines.some((line) => line.summary.includes("Standup"))).toBe(false);
    const again = await buildRoundup(
      { ...deps, now: new Date("2026-04-02T18:00:00.000Z") },
      { save: false, since: "2026-04-02T15:00:00.000Z" },
    );
    expect(again.lines.find((line) => line.write)?.id).toBe(id);
  });
});

function quietGithub(): GitHubApi {
  return {
    async listInstallations() { return [{ id: 1, accountLogin: "acme" }]; },
    async listInstallationRepos() { return { truncated: false, repos: [{ fullName: "acme/app", installationId: 1, defaultBranch: "main" }] }; },
    async listBranches() { return { truncated: false, branches: [{ name: "main", sha: "aaa" }] }; },
    async listPulls() { return { truncated: false, pulls: [] }; },
    async listIssues() { return { truncated: false, issues: [] }; },
    async listCommits() { return { truncated: false, commits: [] }; },
    async compare() { return { truncated: false, files: [] }; },
    async listIssueComments() { return { truncated: false, comments: [] }; },
    async listReviewComments() { return { truncated: false, comments: [] }; },
  };
}
