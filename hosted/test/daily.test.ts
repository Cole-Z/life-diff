import { describe, expect, it } from "vitest";
import { clearHistory, endSession, logAction, recordProxyCall, sessionPortFromBook, startSession } from "../src/app/service";
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

  it("keeps one heading when lookups for a repository are not consecutive", async () => {
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
    await startSession(deps, {});
    const reads: { at: string; repo: string; path: string }[] = [
      { at: "2026-04-02T16:00:00.000Z", repo: "facebook/react", path: "a" },
      { at: "2026-04-02T16:05:00.000Z", repo: "vuejs/core", path: "b" },
      { at: "2026-04-02T16:10:00.000Z", repo: "facebook/react", path: "c" },
    ];
    for (const read of reads) {
      deps.now = new Date(read.at);
      await recordProxyCall(deps, {
        upstream: "deepwiki",
        tool: "read_wiki_contents",
        args: { repo: read.repo, path: read.path },
        ok: true,
        status: "ok",
        summary: `Looked up ${read.repo}.`,
        classification: { effect: "read", tone: "read", verb: "read" },
        durationMs: 2,
      });
    }
    await endSession(deps, {});
    const day = await buildRoundup({ ...deps, issuer: "https://lifediff.dev" }, { save: false, detail: true });
    const headings = day.markdown.split("\n").map((line) => line.trim()).filter((line) => line === "facebook/react");
    expect(headings).toEqual(["facebook/react"]);
    const vueAt = day.markdown.indexOf("vuejs/core");
    const beforeVue = day.markdown.slice(0, vueAt);
    expect(beforeVue.split("facebook/react").length - 1).toBe(3);
    const repoHeads = [...day.html.matchAll(/class="repo">([^<]+)/g)].map((match) => match[1]);
    expect(repoHeads.filter((head) => head === "facebook/react")).toEqual(["facebook/react"]);
    expect(repoHeads.indexOf("facebook/react")).toBeLessThan(repoHeads.indexOf("vuejs/core"));
  });

  it("groups each lookup under its own repo, and leaves a line with no repo under Other", async () => {
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
    await startSession(deps, {});
    await recordProxyCall(deps, {
      upstream: "deepwiki",
      tool: "read_wiki_structure",
      args: { repoName: "golang/go" },
      ok: true,
      status: "ok",
      summary: "Looked up the docs outline for golang/go in DeepWiki.",
      classification: { effect: "read", tone: "read", verb: "read" },
      durationMs: 4,
    });
    await logAction(deps, { tool: "deepwiki", action: "read", target: "vercel/next.js wiki structure" });
    await logAction(deps, { tool: "deepwiki", action: "read", target: "acme/widgets wiki structure", repo: "vuejs/core" });
    await logAction(deps, { tool: "deepwiki", action: "read", target: "inbox" });
    const day = await buildRoundup({ ...deps, issuer: "https://lifediff.dev" }, { save: false, detail: true });
    const body = day.markdown.slice(day.markdown.indexOf("**DeepWiki**"));
    const headings = [...body.matchAll(/^(golang\/go|vercel\/next\.js|vuejs\/core|Other)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(["golang/go", "vercel/next.js", "vuejs/core", "Other"]);
    const vercel = body.indexOf("\nvercel/next.js\n");
    const vue = body.indexOf("\nvuejs/core\n");
    const other = body.indexOf("\nOther\n");
    expect(body.slice(0, vercel)).not.toContain("vercel/next.js wiki structure");
    expect(body.slice(vercel, vue)).toContain("vercel/next.js wiki structure");
    expect(body.slice(vue, other)).toContain("acme/widgets wiki structure");
    expect(body.slice(0, vue)).not.toContain("acme/widgets");
    expect(body.slice(other)).toContain("inbox");
    expect(body.slice(0, other)).not.toContain("inbox");
    expect(day.html).toContain('<h3 class="repo">vercel/next.js</h3>');
    expect(day.html).toContain('<h3 class="repo">Other</h3>');
    expect(day.html.indexOf("vercel/next.js wiki structure")).toBeGreaterThan(day.html.indexOf('<h3 class="repo">vercel/next.js</h3>'));
    expect(day.html.indexOf("vercel/next.js wiki structure")).toBeLessThan(day.html.indexOf('<h3 class="repo">vuejs/core</h3>'));
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
