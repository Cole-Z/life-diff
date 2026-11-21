import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTION_VALUES, validateAction } from "../src/actions/log";
import { endSession, logAction, recordProxyCall, sessionPortFromBook, startSession } from "../src/app/service";
import { glyphRows, renderCardPng } from "../src/receipt/card";
import { displayName } from "../src/receipt/names";
import { buildRoundup } from "../src/receipt/roundup";
import { condenseLines, headlineFor, renderStory, storyFromActions, storyFromReceipt, type StoryLine } from "../src/receipt/story";
import { SessionBook } from "../src/session/book";
import { MemoryMetadataStore, MemoryObjectStore } from "../src/storage/memory";
import type { GitHubApi } from "../src/github/types";
import type { Change, Receipt, RecordedAction } from "../src/receipt/types";

const now = new Date("2026-04-02T16:00:00.000Z");

describe("reclassification", () => {
  it("folds stored unknown calls into the lookup count once", () => {
    const stored = [
      recorded("u", "read_wiki_structure", "unknown", "Used Deepwiki with 'facebook/react'.", { repoName: "facebook/react" }),
      ...Array.from({ length: 5 }, (_, index) => recorded(`r${index}`, "read_wiki_contents", "read", "Read read_wiki_contents from Deepwiki.", { repoName: "facebook/react" })),
    ];
    const lines = condenseLines(storyFromActions(stored), { detail: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.readCount).toBe(6);
    expect(lines[0]?.summary).toBe("6 lookups");
    const encoded = JSON.stringify(lines);
    expect(encoded).not.toContain("read_wiki_structure");
    expect(encoded).not.toContain("Used Deepwiki");
    expect(encoded).toContain("docs outline");
  });
});

describe("headlines", () => {
  it("says what changed in plain words", () => {
    const read = line("read", false);
    const write = line("created", true);
    const failed = line("failed", false);
    expect(headlineFor([], "This session")).toBe("Nothing changed");
    expect(headlineFor([], "Today")).toBe("Nothing changed");
    expect(headlineFor([read, read], "Today")).toBe("Nothing changed · 2 lookups");
    expect(headlineFor([read, read], "This session")).toBe("Nothing changed · 2 lookups");
    expect(headlineFor([read], "This session")).toBe("Nothing changed · 1 lookup");
    expect(headlineFor([write, failed], "This session")).toBe("1 thing changed, 1 needs a look");
    expect(headlineFor([failed], "Today")).toBe("1 action failed");
    expect(headlineFor([failed, failed], "Today")).toBe("2 actions failed");
    expect(headlineFor([write, write], "Today")).toBe("2 things changed");
    expect(headlineFor([write, failed], "Today")).toBe("1 thing changed, 1 needs a look");
  });
});

describe("display names", () => {
  it("uses the brand and otherwise title-cases", () => {
    expect(displayName("deepwiki")).toBe("DeepWiki");
    expect(displayName("google_calendar")).toBe("Google Calendar");
    expect(displayName("gmail")).toBe("Gmail");
    expect(displayName("my_notes")).toBe("My Notes");
  });
});

describe("badges and grouping", () => {
  it("names the service, the repo, the agent, and who confirmed the line", () => {
    const lines = condenseLines(storyFromActions([
      recorded("w", "create_issue", "created", "Added an issue.", { title: "Fix login", number: 12, repo: "cole-z/cardpost" }, "github", "Grok Bot"),
      recorded("r", "list_pages", "read", "Listed pages.", { query: "notes" }, "notes", "Cursor"),
    ]), { detail: false });
    const markdown = renderStory({
      headline: headlineFor(lines, "Today"),
      lines,
      link: "https://lifediff.dev/roundup/2026-04-02",
      linkLabel: "Full day",
    });
    expect(markdown.startsWith("1 thing changed")).toBe(true);
    expect(markdown).toContain("**GitHub**");
    expect(markdown).toContain("cole-z/cardpost: 1 issue by Grok Bot");
    expect(markdown).toContain("Created issue #12 'Fix login' in cole-z/cardpost");
    expect(markdown).toContain("Seen by Life Diff");
    expect(markdown).not.toContain("Reported by the agent");
    expect(markdown).toContain("**Notes**");
    expect(markdown).toContain("1 lookup");
    expect(markdown).not.toContain("create_issue");
    expect(markdown).not.toContain("list_pages");
  });

  it("flags a close the service does not show", () => {
    const receipt = receiptWith(
      [recorded("c", "close_issue", "removed", "Closed #4.", { number: 4 })],
      [{
        id: "chg",
        service: "github",
        kind: "modified",
        resourceId: "issue:acme/app:4",
        resourceName: "Bug",
        summary: "Issue #4 is still open.",
        fields: [{ field: "status", label: "Status", before: "open", after: "open" }],
        confidence: "high",
        confidenceReason: "during the session",
        resourceType: "issue",
        repo: "acme/app",
      }],
    );
    const markdown = renderStory({
      headline: "1 action failed",
      lines: condenseLines(storyFromReceipt(receipt), { detail: false }),
      link: "https://lifediff.dev/receipts/rcpt_test",
      linkLabel: "Full receipt",
    });
    expect(markdown).toContain("Agent said it closed #4, but GitHub shows it still open.");
    expect(markdown).toContain("Confirmed by GitHub");
  });
});

describe("logged reads", () => {
  it("accepts only the action enum, and counts a read with the lookups", async () => {
    const schema = z.object({
      sessionId: z.string(),
      tool: z.string(),
      action: z.enum(ACTION_VALUES),
      target: z.string(),
    });
    expect(schema.safeParse({ sessionId: "ses_1", tool: "deepwiki", action: "read", target: "x" }).success).toBe(true);
    expect(schema.safeParse({ sessionId: "ses_1", tool: "deepwiki", action: "nope", target: "x" }).success).toBe(false);
    expect(validateAction({ tool: "deepwiki", action: "read", target: "x" }).action).toBe("read");
    expect(() => validateAction({ tool: "deepwiki", action: "nope", target: "x" })).toThrow(/added, removed, modified, or read/);

    const book = new SessionBook();
    const deps = base(book);
    const started = await startSession(deps, {});
    const logged = await logAction(deps, { sessionId: started.sessionId, tool: "deepwiki", action: "read", target: "x" });
    expect(logged.source).toBe("claim");
    expect(logged.effect).toBe("read");
    expect(logged.tone).toBe("read");
    const ended = await endSession(deps, {});
    expect(ended.receipt.actions?.[0]?.source).toBe("claim");
    expect(ended.receipt.claimsChecked).toBe(true);
    expect(ended.receipt.claims).toHaveLength(1);
    expect(ended.receipt.claims[0]?.status).toBe("missing");
    const lines = condenseLines(storyFromReceipt(ended.receipt), { detail: false });
    expect(lines.find((item) => item.tone === "read")?.readCount).toBe(1);
    expect(lines.find((item) => item.tone === "read")?.summary).toBe("1 lookup");
    expect(lines.find((item) => item.tone === "read")?.trust).toBe("Reported by the agent");
    expect(JSON.stringify(lines)).not.toContain("deepwiki__");
  });
});

describe("claim corroboration", () => {
  it("counts a read claim that matches a proxied call once, on the receipt and the day", async () => {
    const book = new SessionBook();
    const deps = base(book);
    await startSession(deps, {});
    await recordProxyCall(deps, {
      upstream: "deepwiki",
      tool: "read_wiki_structure",
      args: { repoName: "facebook/react" },
      ok: true,
      status: "ok",
      summary: "Looked up the docs outline for facebook/react in DeepWiki.",
      classification: { effect: "read", tone: "read", verb: "read" },
      durationMs: 4,
    });
    await recordProxyCall(deps, {
      upstream: "deepwiki",
      tool: "read_wiki_contents",
      args: { repoName: "facebook/react" },
      ok: true,
      status: "ok",
      summary: "Looked up the docs for facebook/react in DeepWiki.",
      classification: { effect: "read", tone: "read", verb: "read" },
      durationMs: 4,
    });
    const logged = await logAction(deps, { tool: "deepwiki", action: "read", target: "facebook/react wiki structure" });
    expect(logged.source).toBe("claim");
    const open = await buildRoundup({ ...deps, issuer: "https://lifediff.dev" }, { save: false });
    expect(open.markdown).toContain("Nothing changed · 2 lookups");
    expect(open.markdown).not.toContain("3 lookups");
    const ended = await endSession(deps, {});
    expect(book.getOpen()).toBeNull();
    expect(ended.receipt.actions).toHaveLength(2);
    expect(ended.receipt.actions?.every((action) => action.source === "proxy")).toBe(true);
    const corroborated = ended.receipt.actions?.filter((action) => action.corroborated);
    expect(corroborated).toHaveLength(1);
    expect(corroborated?.[0]?.tool).toBe("read_wiki_structure");
    expect(ended.receipt.claimsChecked).toBe(true);
    expect(ended.receipt.claims).toEqual([expect.objectContaining({
      action: "read",
      status: "verified",
      corroborated: true,
      target: "facebook/react wiki structure",
      matchedActionId: corroborated?.[0]?.id,
    })]);
    const lines = condenseLines(storyFromReceipt(ended.receipt), { detail: false });
    expect(lines.find((item) => item.tone === "read")?.readCount).toBe(2);
    expect(lines.find((item) => item.tone === "read")?.trust).toBe("Seen by Life Diff");
    const day = await buildRoundup({ ...deps, issuer: "https://lifediff.dev" }, { save: false });
    expect(day.markdown).toContain("Nothing changed · 2 lookups");
    expect(day.markdown).toContain("Seen by Life Diff");
    expect(day.markdown).not.toContain("3 lookups");
    expect(day.markdown).not.toContain("Reported by the agent");
  });

  it("still counts a read claim whose target does not match, and keeps its source", async () => {
    const book = new SessionBook();
    const deps = base(book);
    await startSession(deps, {});
    await recordProxyCall(deps, {
      upstream: "deepwiki",
      tool: "read_wiki_structure",
      args: { repoName: "facebook/react" },
      ok: true,
      status: "ok",
      summary: "Looked up the docs outline for facebook/react in DeepWiki.",
      classification: { effect: "read", tone: "read", verb: "read" },
      durationMs: 4,
    });
    await logAction(deps, { tool: "deepwiki", action: "read", target: "vuejs/core wiki structure" });
    const ended = await endSession(deps, {});
    expect(ended.receipt.actions).toHaveLength(2);
    expect(ended.receipt.actions?.map((action) => action.source)).toEqual(["proxy", "claim"]);
    expect(ended.receipt.actions?.some((action) => action.corroborated)).toBe(false);
    expect(ended.receipt.claims[0]?.status).toBe("missing");
    const lines = condenseLines(storyFromReceipt(ended.receipt), { detail: false });
    const reads = lines.filter((item) => item.tone === "read");
    expect(reads).toHaveLength(2);
    expect(reads.map((item) => item.trust)).toEqual(["Seen by Life Diff", "Reported by the agent"]);
    expect(reads.reduce((sum, item) => sum + (item.readCount ?? 1), 0)).toBe(2);
  });
});

describe("quiet days and last viewed", () => {
  it("skips a stored roundup of only lookups, and since last_viewed drops older lines", async () => {
    const book = new SessionBook();
    const meta = new MemoryMetadataStore();
    const deps = base(book, meta);
    await startSession(deps, {});
    await recordProxyCall(deps, call("create_event", { title: "Morning" }, "Created Morning."));
    await recordProxyCall({ ...deps, now: new Date("2026-04-02T18:00:00.000Z") }, call("create_event", { title: "Evening" }, "Created Evening."));
    await endSession({ ...deps, now: new Date("2026-04-02T18:05:00.000Z") }, {});
    await meta.saveSettings("42", {
      timeZone: "UTC",
      dayEnd: "18:00",
      githubDaily: false,
      idleMinutes: 20,
      quietDays: false,
      lastViewedAt: "2026-04-02T17:00:00.000Z",
    }, deps.now.toISOString());
    const since = await buildRoundup({ ...deps, now: new Date("2026-04-02T18:05:00.000Z"), issuer: "https://lifediff.dev" }, { save: false, since: "last_viewed" });
    expect(since.markdown).toContain("Evening");
    expect(since.markdown).not.toContain("Morning");

    const quietBook = new SessionBook();
    const quietMeta = new MemoryMetadataStore();
    const quiet = base(quietBook, quietMeta);
    await startSession(quiet, {});
    await recordProxyCall(quiet, call("list_pages", { query: "notes" }, "Listed notes."));
    await endSession(quiet, {});
    await quietMeta.saveSettings("42", {
      timeZone: "UTC",
      dayEnd: "18:00",
      githubDaily: false,
      idleMinutes: 20,
      quietDays: true,
    }, quiet.now.toISOString());
    const roundup = await buildRoundup({ ...quiet, issuer: "https://lifediff.dev" }, { save: true });
    expect(roundup.markdown).toContain("Nothing changed · 1 lookup");
    expect(await quietMeta.getDaily("42", "2026-04-02")).toBeNull();
  });
});

describe("session card", () => {
  it("prints This session in the header and wraps a long line", async () => {
    const short = await renderCardPng([line("read", false, "Looked up the docs.")], "Life Diff", "This session");
    const today = await renderCardPng([line("read", false, "Looked up the docs.")], "Life Diff", "Today");
    const long = await renderCardPng([line("created", true, `Created page '${"goals ".repeat(40)}' in Notes.`)], "Life Diff", "This session");
    const pixels = await decodePng(short);
    expect(seesCaption(pixels.rgb, pixels.width, "This session")).toBe(true);
    expect(seesCaption(pixels.rgb, pixels.width, "Today")).toBe(false);
    expect(Buffer.from(short).equals(Buffer.from(today))).toBe(false);
    const shortHeight = pngHeight(short);
    const longHeight = pngHeight(long);
    expect(longHeight).toBeGreaterThan(shortHeight);
    expect(glyphRows("“")).toEqual(glyphRows('"'));
  });
});

function recorded(
  id: string,
  tool: string,
  tone: RecordedAction["tone"],
  summary: string,
  args: Record<string, unknown>,
  upstream = "deepwiki",
  client?: string,
): RecordedAction {
  return {
    id,
    time: now.toISOString(),
    upstream,
    tool,
    summary,
    tone,
    effect: tone === "read" || tone === "unknown" ? "read" : "write",
    ok: true,
    status: "ok",
    arguments: args,
    source: "proxy",
    ...(client ? { client } : {}),
  };
}

function line(tone: StoryLine["tone"], write: boolean, summary?: string): StoryLine {
  const text = summary ?? tone;
  return { service: "notes", source: "proxy", write, tone, summary: text, seed: text, ...(tone === "read" ? { readCount: 1 } : {}) };
}

function receiptWith(actions: RecordedAction[], changes: Change[]): Receipt {
  return {
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
    counts: { added: 0, removed: 0, modified: 0, verifiedClaims: 0, missingClaims: 0, unclaimedChanges: 0 },
    claimsChecked: false,
    claims: [],
    notes: [],
    changes,
    actions,
  };
}

function base(book: SessionBook, meta = new MemoryMetadataStore()) {
  return {
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
    objects: new MemoryObjectStore(),
    github: quietGithub(),
  };
}

function call(tool: string, args: Record<string, unknown>, summary: string) {
  const write = tool.startsWith("create");
  return {
    upstream: write ? "google_calendar" : "notes",
    tool,
    args,
    ok: true,
    status: "ok",
    summary,
    classification: write
      ? { effect: "write" as const, tone: "created" as const, verb: "create" }
      : { effect: "read" as const, tone: "read" as const, verb: "list" },
    durationMs: 3,
  };
}

function quietGithub(): GitHubApi {
  return {
    async listInstallations() { return []; },
    async listInstallationRepos() { return { truncated: false, repos: [] }; },
    async listBranches() { return { truncated: false, branches: [] }; },
    async listPulls() { return { truncated: false, pulls: [] }; },
    async listIssues() { return { truncated: false, issues: [] }; },
    async listCommits() { return { truncated: false, commits: [] }; },
    async compare() { return { truncated: false, files: [] }; },
    async listIssueComments() { return { truncated: false, comments: [] }; },
    async listReviewComments() { return { truncated: false, comments: [] }; },
  };
}

function pngHeight(png: Uint8Array): number {
  return new DataView(png.buffer, png.byteOffset + 20, 4).getUint32(0);
}

async function decodePng(png: Uint8Array): Promise<{ width: number; height: number; rgb: Uint8Array }> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const parts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4] ?? 0, png[offset + 5] ?? 0, png[offset + 6] ?? 0, png[offset + 7] ?? 0);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") parts.push(data);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const compressed = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    compressed.set(part, cursor);
    cursor += part.length;
  }
  const raw = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const stride = width * 3;
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    rgb.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, rgb };
}

function seesCaption(rgb: Uint8Array, width: number, text: string): boolean {
  const advance = 12;
  for (let index = 0; index < text.length; index += 1) {
    const rows = glyphRows(text[index] ?? "");
    if (!rows || rows.every((bits) => bits === 0)) continue;
    let found = false;
    for (let row = 0; row < rows.length && !found; row += 1) {
      const bits = rows[row] ?? 0;
      for (let col = 0; col < 5; col += 1) {
        if ((bits & (1 << (4 - col))) === 0) continue;
        const px = 20 + index * advance + col * 2;
        const py = 40 + row * 2;
        const at = (py * width + px) * 3;
        if (rgb[at] === 246 && rgb[at + 1] === 241 && rgb[at + 2] === 231) found = true;
      }
    }
    if (!found) return false;
  }
  return true;
}
