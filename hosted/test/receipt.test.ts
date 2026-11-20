import { describe, expect, it } from "vitest";
import { diffGitHub } from "../src/github/diff";
import type { AfterRead, GitHubSnapshot } from "../src/github/types";
import { buildReceipt } from "../src/receipt/build";
import { applyClaims } from "../src/receipt/claims";
import { confidenceAt } from "../src/receipt/confidence";
import { renderHtml } from "../src/receipt/html";

const started = "2026-04-02T15:00:00.000Z";
const checked = "2026-04-02T15:40:00.000Z";

function snapshot(): GitHubSnapshot {
  return {
    schemaVersion: "1.0.0",
    id: "snap_test",
    takenAt: started,
    login: "octocat",
    warnings: [],
    repos: [{
      fullName: "acme/app",
      defaultBranch: "main",
      defaultSha: "aaa1111",
      branches: [
        { name: "main", sha: "aaa1111" },
        { name: "feature", sha: "bbb2222" },
      ],
      pulls: [{
        number: 1,
        title: "Fix login",
        state: "open",
        merged: false,
        draft: false,
        user: { login: "octocat", type: "User" },
        headRef: "feature",
        headSha: "bbb2222",
        baseRef: "main",
        labels: [],
        updatedAt: started,
        htmlUrl: "https://github.com/acme/app/pull/1",
      }],
      issues: [{
        number: 2,
        title: "Bug",
        state: "open",
        user: { login: "octocat" },
        labels: ["bug"],
        updatedAt: started,
      }],
    }],
  };
}

function after(): AfterRead {
  const before = snapshot();
  const repo = structuredClone(before.repos[0]!);
  repo.defaultSha = "ccc3333";
  repo.branches = [
    { name: "main", sha: "ccc3333" },
    { name: "topic", sha: "ddd4444" },
  ];
  repo.pulls = [{
    ...repo.pulls[0]!,
    title: "Fix login flow",
    labels: ["bug"],
    headSha: "ccc3333",
    updatedAt: "2026-04-02T15:20:00.000Z",
  }];
  repo.issues = [
    { ...repo.issues[0]!, state: "closed", updatedAt: "2026-04-02T15:25:00.000Z" },
    {
      number: 3,
      title: "Docs",
      state: "open",
      user: { login: "hubot", type: "Bot" },
      labels: [],
      updatedAt: "2026-04-02T15:30:00.000Z",
      htmlUrl: "https://github.com/acme/app/issues/3",
    },
  ];
  return {
    snapshot: { ...before, takenAt: checked, repos: [repo], warnings: [] },
    commits: [{
      repo: "acme/app",
      sha: "ccc3333",
      message: "Fix login flow",
      author: { login: "octocat", type: "User" },
      committedAt: "2026-04-02T15:18:00.000Z",
      htmlUrl: "https://github.com/acme/app/commit/ccc3333",
    }],
    comments: [{
      repo: "acme/app",
      id: 9,
      kind: "issue",
      number: 1,
      body: "Looks good",
      user: { login: "copilot[bot]", type: "Bot" },
      createdAt: "2026-04-02T15:22:00.000Z",
      viaApp: { slug: "copilot", name: "Copilot" },
      htmlUrl: "https://github.com/acme/app/pull/1#issuecomment-9",
    }],
    files: [{
      repo: "acme/app",
      path: "src/login.ts",
      status: "modified",
      additions: 10,
      deletions: 2,
      committedAt: "2026-04-02T15:18:00.000Z",
      actor: { login: "octocat" },
      htmlUrl: "https://github.com/acme/app/blob/ccc3333/src/login.ts",
    }],
    suppressedRepos: [],
    truncatedChanges: false,
  };
}

describe("confidence", () => {
  it("rates timestamps the way the core receipt does", () => {
    expect(confidenceAt("2026-04-02T15:10:00.000Z", started, checked)).toBe("high");
    expect(confidenceAt("2026-04-02T14:50:00.000Z", started, checked)).toBe("medium");
    expect(confidenceAt("2026-03-01T12:00:00.000Z", started, checked)).toBe("low");
    expect(confidenceAt(undefined, started, checked)).toBe("medium");
    expect(confidenceAt("2026-04-02T16:00:00.000Z", started, checked)).toBe("medium");
  });
});

describe("GitHub diff", () => {
  const diff = diffGitHub(snapshot(), after(), checked);

  it("reports commits, branches, pull requests, issues, comments, and files", () => {
    const types = diff.changes.map((change) => `${change.kind}:${change.resourceType}:${change.resourceName}`);
    expect(types).toContain("added:commit:Fix login flow");
    expect(types).toContain("added:branch:topic");
    expect(types).toContain("removed:branch:feature");
    expect(types).toContain("modified:branch:main");
    expect(types).toContain("modified:pull_request:Fix login flow");
    expect(types).toContain("modified:issue:Bug");
    expect(types).toContain("added:issue:Docs");
    expect(types).toContain("added:comment:Looks good");
    expect(types).toContain("modified:file:src/login.ts");
  });

  it("attributes the actor and the app GitHub named", () => {
    const commit = diff.changes.find((change) => change.resourceType === "commit");
    const comment = diff.changes.find((change) => change.resourceType === "comment");
    expect(commit?.actor?.login).toBe("octocat");
    expect(commit?.summary).toContain("by octocat");
    expect(comment?.viaApp?.slug).toBe("copilot");
    expect(comment?.summary).toContain("via Copilot");
    expect(comment?.confidence).toBe("high");
  });

  it("does not keep file bodies", () => {
    const file = diff.changes.find((change) => change.resourceType === "file");
    expect(JSON.stringify(file)).not.toContain("function");
    expect(file?.fields.find((field) => field.field === "content")?.after).toBe("+10 −2");
  });
});

describe("claims and receipt", () => {
  it("verifies a phrase match, marks a missing claim, and leaves the rest unclaimed", () => {
    const diff = diffGitHub(snapshot(), after(), checked);
    const applied = applyClaims(diff.changes, [
      { id: "claim_login", service: "pull_request", action: "modified", target: "Fix login", detail: "Renamed the pull request" },
      { service: "issue", action: "added", target: "Docs" },
      { action: "added", target: "Nope" },
    ]);
    const login = applied.claims.find((claim) => claim.id === "claim_login");
    const docs = applied.claims.find((claim) => claim.target === "Docs");
    const nope = applied.claims.find((claim) => claim.target === "Nope");
    expect(login?.status).toBe("verified");
    expect(login?.matchedChangeIds).toHaveLength(1);
    expect(docs?.status).toBe("verified");
    expect(nope?.status).toBe("missing");
    expect(nope?.reason).toContain("GitHub");
    const matched = applied.changes.find((change) => change.id === login?.matchedChangeIds?.[0]);
    expect(matched?.claimStatus).toBe("verified");
    expect(applied.changes.some((change) => change.claimStatus === "unclaimed")).toBe(true);
  });

  it("treats moved and created the same way the core does", () => {
    const diff = diffGitHub(snapshot(), after(), checked);
    const applied = applyClaims(diff.changes, [
      { action: "moved", target: "src/login.ts" },
      { action: "created", target: "Docs" },
    ]);
    expect(applied.claims[0]?.status).toBe("verified");
    expect(applied.claims[0]?.action).toBe("modified");
    expect(applied.claims[1]?.status).toBe("verified");
    expect(applied.claims[1]?.action).toBe("added");
  });

  it("writes a schema 1.0.0 receipt and the shared report language", () => {
    const before = snapshot();
    const receipt = buildReceipt({
      receiptId: "rcpt_test",
      before,
      after: after(),
      checkedAt: checked,
      timeZone: "America/New_York",
      claims: [{ target: "Docs", action: "added", service: "issue" }],
    });
    expect(receipt.schemaVersion).toBe("1.0.0");
    expect(receipt.readOnly).toBe(true);
    expect(receipt.producer.name).toBe("lifediff-hosted");
    expect(receipt.snapshot).toEqual({ id: "snap_test", takenAt: started });
    expect(receipt.session.startedAt).toBe(started);
    expect(receipt.github.diffMode).toBe("snapshot");
    expect(receipt.counts.added).toBeGreaterThan(0);
    expect(receipt.counts.verifiedClaims).toBe(1);
    expect(receipt.claimsChecked).toBe(true);
    expect(JSON.stringify(receipt)).not.toMatch(/ghu_|access_token|client_secret/);
    const html = renderHtml(receipt);
    expect(html).toContain("--added: #0f5c32");
    expect(html).toContain("--removed: #8d1c1c");
    expect(html).toContain("--modified: #6b4300");
    expect(html).toContain("badge-added");
    expect(html).toContain("badge-removed");
    expect(html).toContain("badge-modified");
    expect(html).toContain("M7 1h2v14H7z");
    expect(html).toContain(">Added<");
    expect(html).toContain(">Removed<");
    expect(html).toContain(">Modified<");
    expect(html).toContain("Open on GitHub");
    expect(html).toContain("Life Diff did not change any GitHub data.");
    expect(html).not.toContain("<script");
  });

  it("escapes names in the report", () => {
    const before = snapshot();
    const read = after();
    read.snapshot.repos[0]!.issues[1]!.title = `<script>alert("x")</script>`;
    const receipt = buildReceipt({
      receiptId: "rcpt_escape",
      before,
      after: read,
      checkedAt: checked,
      timeZone: "UTC",
      claims: null,
    });
    const html = renderHtml(receipt);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});
