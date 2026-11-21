import { describe, expect, it } from "vitest";
import { clearHistory, endSession, recordProxyCall, sessionPortFromBook, startSession } from "../src/app/service";
import { glyphRows, renderCardPng } from "../src/receipt/card";
import { buildRoundup } from "../src/receipt/roundup";
import { condenseLines, storyFromActions, storyFromChanges } from "../src/receipt/story";
import { SessionBook } from "../src/session/book";
import { MemoryMetadataStore, MemoryObjectStore } from "../src/storage/memory";
import { dueDays } from "../src/time";
import type { Change, RecordedAction } from "../src/receipt/types";
import type { GitHubApi } from "../src/github/types";

describe("grouped lines", () => {
  it("rolls a merged pull request and its files into one line", () => {
    const lines = condenseLines(storyFromChanges("rcpt", [
      change("modified", "pull_request", 'Merged pull request "Record every proxied tool call" (#8) on acme/app', "Record every proxied tool call"),
      change("added", "file", "Added src/a.ts", "src/a.ts", "+2,100 −100"),
      change("modified", "file", "Updated src/b.ts", "src/b.ts", "+0 −50"),
    ]), { detail: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.summary).toBe('Merged PR #8 "Record every proxied tool call" · 2 files · +2,100 −150');
    expect(lines[0]?.details?.map((detail) => detail.text).join(" ")).toContain("src/a.ts");
  });

  it("marks a failure and collapses the retry that succeeded", () => {
    const failed = storyFromActions([action("a", false, "Asked Deepwiki: “How does React work?”.")]);
    expect(failed[0]?.tone).toBe("failed");
    const lines = condenseLines(storyFromActions([
      action("a", false, "Asked Deepwiki: “How does React work?”."),
      action("b", true, "Asked Deepwiki: “How does React work?”."),
    ]), { detail: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.ok).toBe(true);
    expect(lines[0]?.summary).toContain("How does React work?");
    const stuck = condenseLines(storyFromActions([
      action("a", false, "Deepwiki failed on “How does React work?”."),
      action("c", false, "Deepwiki failed on “How does React work?”."),
    ]), { detail: true });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.tone).toBe("failed");
  });

  it("hides reads behind one count unless detail is requested", () => {
    const reads = [action("r1", true, "Read the structure.", "read"), action("r2", true, "Read the page.", "read")];
    const collapsed = condenseLines(storyFromActions(reads), { detail: false });
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.summary).toBe("2 lookups");
    expect(condenseLines(storyFromActions(reads), { detail: true })).toHaveLength(2);
  });
});

describe("card glyphs", () => {
  it("folds a curly quote onto the straight quote the font has", async () => {
    expect(glyphRows("“")).toEqual(glyphRows('"'));
    expect(glyphRows("“")).not.toEqual(glyphRows("?"));
    const line = { service: "deepwiki", source: "proxy" as const, write: false, tone: "read" as const, seed: "card", summary: "" };
    const curly = await renderCardPng([{ ...line, summary: "Asked “how”." }], "Life Diff", "This session");
    const straight = await renderCardPng([{ ...line, summary: "Asked \"how\"." }], "Life Diff", "This session");
    const marks = await renderCardPng([{ ...line, summary: "Asked ?how?." }], "Life Diff", "This session");
    expect(Buffer.from(curly).equals(Buffer.from(straight))).toBe(true);
    expect(Buffer.from(curly).equals(Buffer.from(marks))).toBe(false);
  });
});

describe("the local day", () => {
  it("finalizes yesterday before the workday ends, and today once it has", () => {
    const zone = "America/Chicago";
    const before = dueDays(new Date("2026-04-02T22:59:00.000Z"), zone, "18:00", new Set());
    expect(before).toEqual(["2026-04-01"]);
    const after = dueDays(new Date("2026-04-02T23:00:00.000Z"), zone, "18:00", new Set());
    expect(after).toEqual(["2026-04-01", "2026-04-02"]);
    const done = dueDays(new Date("2026-04-02T23:00:00.000Z"), zone, "18:00", new Set(["2026-04-02"]));
    expect(done).toEqual(["2026-04-01"]);
  });

  it("leaves GitHub out of the daily diff unless the user turned it on for that session", async () => {
    const store = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    const book = new SessionBook();
    const deps = {
      userId: "42",
      login: "octocat",
      now: new Date("2026-04-02T16:00:00.000Z"),
      timeZone: "UTC",
      maxRepos: 25,
      receiptRetentionDays: 90,
      snapshotRetentionHours: 24,
      abandonedSessionDays: 7,
      github: closingIssue(),
      sessions: sessionPortFromBook(book),
      meta: store,
      objects,
    };
    await startSession(deps, { repos: ["acme/app"] });
    await recordProxyCall(deps, {
      upstream: "deepwiki",
      tool: "ask_question",
      args: { repo: "facebook/react", question: "How does React work?" },
      ok: true,
      status: "ok",
      summary: "Asked Deepwiki: “How does React work?”.",
      classification: { effect: "write", tone: "created", verb: "ask" },
      durationMs: 4,
    });
    await endSession(deps, {});
    const hidden = await buildRoundup({ ...deps, issuer: "https://lifediff.dev" }, { save: false });
    expect(hidden.markdown).toContain("1 lookup");
    expect(hidden.markdown).not.toContain("acme/app");
    await store.saveSettings("42", { timeZone: "America/Chicago", dayEnd: "18:00", githubDaily: true, idleMinutes: 20, quietDays: false }, deps.now.toISOString());
    const shown = await buildRoundup({ ...deps, issuer: "https://lifediff.dev" }, { save: false });
    expect(shown.markdown).toContain("acme/app");
  });

  it("deletes history and keeps upstream servers", async () => {
    const store = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    await store.insertUpstream({
      id: "up_1",
      userId: "42",
      name: "deepwiki",
      url: "https://mcp.deepwiki.com/mcp",
      createdAt: "2026-04-02T00:00:00.000Z",
    });
    await store.insertReceipt({
      id: "rcpt_1",
      userId: "42",
      sessionId: "ses_1",
      createdAt: "2026-04-02T00:00:00.000Z",
      expiresAt: "2026-07-01T00:00:00.000Z",
      jsonKey: "users/42/receipts/rcpt_1.json",
      htmlKey: "users/42/receipts/rcpt_1.html",
      added: 0,
      removed: 0,
      modified: 0,
      verifiedClaims: 0,
      missingClaims: 0,
      unclaimedChanges: 0,
    });
    await clearHistory({ userId: "42", meta: store, objects }, async () => undefined);
    expect(await store.listReceipts("42", 20)).toEqual([]);
    expect(await store.listUpstreams("42")).toHaveLength(1);
  });
});

function change(kind: Change["kind"], resourceType: string, summary: string, resourceName: string, content?: string): Change {
  return {
    id: resourceName,
    service: "github",
    kind,
    resourceId: resourceName,
    resourceName,
    summary,
    fields: content ? [{ field: "content", label: "Contents", before: "", after: content }] : [],
    confidence: "high",
    confidenceReason: "test",
    resourceType,
    repo: "acme/app",
  };
}

function action(id: string, ok: boolean, summary: string, tone: RecordedAction["tone"] = "created"): RecordedAction {
  return {
    id,
    time: "2026-04-02T16:00:00.000Z",
    upstream: "deepwiki",
    tool: "ask_question",
    summary,
    tone,
    effect: tone === "read" ? "read" : "write",
    verb: tone === "read" ? "read" : "ask",
    ok,
    status: ok ? "ok" : "error",
    arguments: { repo: "facebook/react", question: "How does React work?" },
    source: "proxy",
  };
}

function closingIssue(): GitHubApi {
  let seen = false;
  const issue = { number: 2, title: "Bug", user: { login: "octocat" }, labels: ["bug"], htmlUrl: "https://github.com/acme/app/issues/2" };
  return {
    async listInstallations() { return [{ id: 1, accountLogin: "acme" }]; },
    async listInstallationRepos() { return { truncated: false, repos: [{ fullName: "acme/app", installationId: 1, defaultBranch: "main" }] }; },
    async listBranches() { return { truncated: false, branches: [{ name: "main", sha: "aaa" }] }; },
    async listPulls() { return { truncated: false, pulls: [] }; },
    async listIssues() {
      const state = seen ? "closed" as const : "open" as const;
      seen = true;
      return { truncated: false, issues: [{ ...issue, state, updatedAt: seen ? "2026-04-02T16:10:00.000Z" : "2026-04-02T15:00:00.000Z" }] };
    },
    async listCommits() { return { truncated: false, commits: [] }; },
    async compare() { return { truncated: false, files: [] }; },
    async listIssueComments() { return { truncated: false, comments: [] }; },
    async listReviewComments() { return { truncated: false, comments: [] }; },
  };
}
