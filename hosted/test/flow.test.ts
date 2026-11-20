import { describe, expect, it } from "vitest";
import { actionsToClaims, validateAction } from "../src/actions/log";
import { endSession, logAction, sessionPortFromBook, startSession } from "../src/app/service";
import { SessionBook } from "../src/session/book";
import { MemoryMetadataStore, MemoryObjectStore } from "../src/storage/memory";
import { deleteUserData, runRetention } from "../src/storage/retention";
import { D1MetadataStore, type Sql } from "../src/storage/d1";
import { revokeAllGrants } from "../src/auth/grants";
import { classify } from "../src/http/routes";
import { renderConsentPage } from "../src/http/pages";
import { GitHubClient } from "../src/github/client";
import type { GitHubApi } from "../src/github/types";

const now = new Date("2026-04-02T15:00:00.000Z");

function fakeApi(): GitHubApi {
  let branchReads = 0;
  return {
    async listInstallations() {
      return [{ id: 1, accountLogin: "acme" }];
    },
    async listInstallationRepos() {
      return { truncated: false, repos: [{ fullName: "acme/app", installationId: 1, defaultBranch: "main" }] };
    },
    async listBranches() {
      branchReads += 1;
      const sha = branchReads === 1 ? "aaa1111" : "ccc3333";
      return { truncated: false, branches: [{ name: "main", sha }] };
    },
    async listPulls() {
      return { truncated: false, pulls: [] };
    },
    async listIssues() {
      return { truncated: false, issues: [] };
    },
    async listCommits() {
      return {
        truncated: false,
        commits: [{
          repo: "acme/app",
          sha: "ccc3333",
          message: "Ship it",
          author: { login: "octocat" },
          committedAt: "2026-04-02T15:10:00.000Z",
        }],
      };
    },
    async compare() {
      return {
        truncated: false,
        files: [{ repo: "acme/app", path: "README.md", status: "added", additions: 3, deletions: 0 }],
      };
    },
    async listIssueComments() {
      return { truncated: false, comments: [] };
    },
    async listReviewComments() {
      return { truncated: false, comments: [] };
    },
  };
}

describe("session flow", () => {
  it("logs a claimed action and verifies it against GitHub", async () => {
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
      github: fakeApi(),
      sessions: sessionPortFromBook(book),
      meta,
      objects,
    };
    const started = await startSession(deps, {});
    expect(started.repos).toEqual(["acme/app"]);
    const again = await startSession(deps, {});
    expect(again.sessionId).toBe(started.sessionId);
    const logged = await logAction({ ...deps, now: new Date("2026-04-02T15:05:00.000Z") }, {
      tool: "github.create_file",
      action: "created",
      target: "README.md",
      repo: "acme/app",
      resource: "file",
      detail: "Added the readme",
    });
    expect(actionsToClaims([logged])[0]?.service).toBe("file");
    const ended = await endSession({ ...deps, now: new Date("2026-04-02T15:40:00.000Z") }, {});
    expect(ended.receipt.claimsChecked).toBe(true);
    expect(ended.receipt.claims[0]?.status).toBe("verified");
    expect(ended.receipt.claims[0]?.detail).toContain("github.create_file");
    expect(ended.html).toContain("badge-added");
    expect(objects.objects.size).toBeGreaterThan(1);
    const keys = await meta.userObjectKeys("42");
    await deleteUserData({
      meta,
      objects,
      sessions: { abandon: async () => undefined, wipe: async () => book.wipe() },
      userId: "42",
    });
    expect(meta.users.size).toBe(0);
    expect(meta.receipts.size).toBe(0);
    expect(book.getOpen()).toBeNull();
    for (const key of keys) expect(objects.objects.has(key)).toBe(false);
  });

  it("closes a session that has been open for 30 minutes and starts another", async () => {
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
      github: fakeApi(),
      sessions: sessionPortFromBook(book),
      meta,
      objects,
    };
    const first = await startSession(deps, {});
    const recent = await startSession({ ...deps, now: new Date("2026-04-02T15:29:00.000Z") }, {});
    expect(recent.sessionId).toBe(first.sessionId);
    const next = await startSession({ ...deps, now: new Date("2026-04-02T15:30:00.000Z") }, {});
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(meta.receipts.size).toBe(1);
    expect(book.getOpen()?.id).toBe(next.sessionId);
  });
});

describe("retention", () => {
  it("drops expired receipts and abandoned snapshots", async () => {
    const meta = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    await meta.insertReceipt({
      id: "rcpt_old",
      userId: "42",
      sessionId: "ses_old",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-04-01T00:00:00.000Z",
      jsonKey: "receipts/42/rcpt_old.json",
      htmlKey: "receipts/42/rcpt_old.html",
      added: 0, removed: 0, modified: 0, verifiedClaims: 0, missingClaims: 0, unclaimedChanges: 0,
    });
    await objects.put("receipts/42/rcpt_old.json", "{}", "application/json");
    await objects.put("receipts/42/rcpt_old.html", "<p></p>", "text/html");
    await meta.insertSession({
      id: "ses_open",
      userId: "42",
      startedAt: "2026-03-01T00:00:00.000Z",
      status: "open",
      snapshotId: "snap_old",
      snapshotKey: "snapshots/42/snap_old.json",
      snapshotExpiresAt: "2026-03-08T00:00:00.000Z",
      timeZone: "UTC",
      repoCount: 1,
    });
    await objects.put("snapshots/42/snap_old.json", "{}", "application/json");
    const abandoned: string[] = [];
    const report = await runRetention({
      meta,
      objects,
      sessions: { abandon: async (_user, sessionId) => { abandoned.push(sessionId); }, wipe: async () => undefined },
      nowIso: "2026-04-02T00:00:00.000Z",
      limit: 20,
    });
    expect(report.receipts).toBe(1);
    expect(report.abandoned).toBe(1);
    expect(abandoned).toEqual(["ses_open"]);
    expect(meta.receipts.size).toBe(0);
    expect(objects.objects.size).toBe(0);
  });
});

describe("D1 statements", () => {
  it("binds the user id instead of interpolating it", async () => {
    const calls: { sql: string; binds: unknown[] }[] = [];
    const db: Sql = {
      prepare(sql: string) {
        const binds: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            binds.splice(0, binds.length, ...values);
            return statement;
          },
          async all<T>() {
            calls.push({ sql, binds: [...binds] });
            return { results: [] as T[] };
          },
          async run() {
            calls.push({ sql, binds: [...binds] });
            return {};
          },
          async first<T>() {
            calls.push({ sql, binds: [...binds] });
            return null as T | null;
          },
        };
        return statement;
      },
    };
    const store = new D1MetadataStore(db);
    await store.deleteUserRows("42'); DROP TABLE users;--");
    expect(calls.map((call) => call.sql).every((sql) => sql.includes("?"))).toBe(true);
    expect(calls.map((call) => call.sql).join("\n")).not.toContain("DROP TABLE");
    expect(calls[0]?.binds[0]).toBe("42'); DROP TABLE users;--");
  });
});

describe("session book", () => {
  it("refuses a second open session and caps the action log", () => {
    const book = new SessionBook();
    const open = {
      id: "ses_1",
      startedAt: "2026-04-02T15:00:00.000Z",
      snapshotId: "snap_1",
      snapshotKey: "snapshots/1/snap_1.json",
      timeZone: "UTC",
      repos: ["acme/app"],
      warnings: [],
    };
    book.start(open);
    expect(() => book.start(open)).toThrow(/already open/);
    for (let i = 0; i < 500; i += 1) {
      book.log("ses_1", { id: `act_${i}`, loggedAt: open.startedAt, tool: "tool", target: `t${i}` });
    }
    expect(() => book.log("ses_1", { id: "act_over", loggedAt: open.startedAt, tool: "tool", target: "over" })).toThrow(/500/);
    book.close("ses_1");
    expect(book.getOpen()).toBeNull();
    expect(() => book.list("ses_1")).toThrow(/not open/);
  });
});

describe("actions", () => {
  it("rejects an empty target and normalizes created", () => {
    expect(() => validateAction({ tool: "x", target: "  " })).toThrow(/target/);
    expect(validateAction({ tool: "edit", target: "README", action: "created", resource: "pr", repo: "acme/app" })).toEqual({
      action: "added",
      resource: "pull_request",
      repo: "acme/app",
    });
  });
});

describe("routes and consent", () => {
  it("sends MCP and the protected-resource metadata to the resource server", () => {
    expect(classify("/mcp")).toBe("mcp");
    expect(classify("/.well-known/oauth-protected-resource/mcp")).toBe("resource-metadata");
    expect(classify("/callback")).toBe("app");
    expect(classify("/v1/me")).toBe("data");
    expect(classify("/receipts/rcpt_1")).toBe("data");
  });

  it("escapes the client name on the consent page", () => {
    const html = renderConsentPage({
      clientName: `<script>alert("x")</script>`,
      redirectHost: "evil.example",
      redirectIsLoopback: false,
      scope: ["receipts:read"],
    }, "handle-1");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("evil.example");
    expect(html).toContain("handle-1");
  });
});

describe("grant revocation", () => {
  it("walks every page of grants", async () => {
    const revoked: string[] = [];
    const count = await revokeAllGrants({
      async listUserGrants(_userId, options) {
        if (!options?.cursor) return { items: [{ id: "g1" }], cursor: "next" };
        return { items: [{ id: "g2" }] };
      },
      async revokeGrant(id) {
        revoked.push(id);
      },
    }, "42");
    expect(count).toBe(2);
    expect(revoked).toEqual(["g1", "g2"]);
  });
});

describe("GitHub client", () => {
  it("calls the API with a bearer token and never puts the token in the URL", async () => {
    const seen: { url: string; authorization: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, authorization: headers.get("authorization") ?? "" });
      const path = new URL(url).pathname;
      if (path === "/user/installations") {
        return Response.json({ installations: [{ id: 9, account: { login: "acme", type: "Organization" } }] });
      }
      if (path === "/repos/acme/app/pulls") {
        return Response.json([{
          number: 4,
          title: "Add docs",
          state: "open",
          user: { login: "octocat", id: 1, type: "User" },
          head: { ref: "docs", sha: "abc1234" },
          base: { ref: "main" },
          labels: [{ name: "docs" }],
          html_url: "https://github.com/acme/app/pull/4",
          updated_at: "2026-04-02T15:00:00Z",
        }]);
      }
      return new Response("no", { status: 404 });
    };
    const client = new GitHubClient({ token: "ghu_test_token", fetch: fetchImpl });
    const installations = await client.listInstallations();
    expect(installations).toEqual([{ id: 9, accountLogin: "acme" }]);
    const pulls = await client.listPulls("acme/app");
    expect(pulls.pulls[0]?.title).toBe("Add docs");
    expect(pulls.pulls[0]?.labels).toEqual(["docs"]);
    expect(seen.every((call) => call.authorization === "Bearer ghu_test_token")).toBe(true);
    expect(seen.every((call) => !call.url.includes("ghu_test_token"))).toBe(true);
    expect(new URL(seen[0]?.url ?? "").hostname).toBe("api.github.com");
  });

  it("refuses a next link that leaves api.github.com", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("page=2")) return new Response("should not follow", { status: 500 });
      return new Response(JSON.stringify([{ name: "main", commit: { sha: "abc" } }]), {
        headers: { link: '<https://evil.example/repos?page=2>; rel="next"', "content-type": "application/json" },
      });
    };
    const client = new GitHubClient({ token: "ghu_test_token", fetch: fetchImpl });
    const branches = await client.listBranches("acme/app");
    expect(branches.branches).toEqual([{ name: "main", sha: "abc" }]);
    expect(branches.truncated).toBe(false);
  });
});
