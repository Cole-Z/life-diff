import { describe, expect, it } from "vitest";
import { endSession, logAction, recordProxyCall, sessionPortFromBook, startSession } from "../src/app/service";
import { classifyToolName } from "../src/proxy/classify";
import { forwardToolCall, toolFailure } from "../src/proxy/forward";
import { redactSnippet } from "../src/proxy/redact";
import { renderCardPng } from "../src/receipt/card";
import { claimSentence } from "../src/receipt/present";
import { receiptPresentation, buildRoundup } from "../src/receipt/roundup";
import { cardRows, condenseLines, headlineFor, isQuiet, storyFromReceipt, trustLabel, type StoryLine } from "../src/receipt/story";
import { SessionBook } from "../src/session/book";
import { MemoryMetadataStore, MemoryObjectStore } from "../src/storage/memory";
import type { GitHubApi } from "../src/github/types";
import type { Receipt, RecordedAction } from "../src/receipt/types";

const now = new Date("2026-04-02T16:00:00.000Z");

describe("1. unverified claims stay on the receipt", () => {
  it("shows a calendar claim that GitHub cannot check", async () => {
    const book = new SessionBook();
    const meta = new MemoryMetadataStore();
    const deps = base(book, meta);
    await startSession(deps, {});
    await logAction(deps, {
      tool: "google_calendar",
      action: "modified",
      target: "Pitney Bowes call moved to Mon 11:30 AM",
    });
    const ended = await endSession(deps, {});
    expect(ended.receipt.claims[0]?.service).toBe("Google Calendar");
    expect(ended.receipt.claims[0]?.service).not.toBe("github");
    expect(ended.receipt.claims[0]?.status).toBe("missing");
    const lines = condenseLines(storyFromReceipt(ended.receipt), { detail: false });
    expect(headlineFor(lines, "This session")).toBe("1 change reported, not verified");
    expect(lines.some((line) => line.service === "Google Calendar" && line.summary.includes("Pitney Bowes"))).toBe(true);
    expect(lines.find((line) => line.summary.includes("Pitney Bowes"))?.trust).toBe("Agent says it did this, not verified");
    const day = await buildRoundup({ ...deps, issuer: "https://lifediff.dev" }, { save: false });
    expect(day.markdown).toContain("1 change reported, not verified");
    expect(day.markdown).toContain("Pitney Bowes");
    expect(day.markdown).toContain("**Google Calendar**");
  });

  it("recovers the service from an older claim stored as github", () => {
    const receipt = receiptWith([], [{
      id: "claim-old",
      service: "github",
      action: "modified",
      target: "Pitney Bowes call moved to Mon 11:30 AM",
      detail: "Tool google_calendar",
      status: "missing",
      reason: "No matching change showed up in GitHub.",
    }]);
    const lines = condenseLines(storyFromReceipt(receipt), { detail: false });
    expect(headlineFor(lines, "This session")).toBe("1 change reported, not verified");
    expect(lines.find((line) => line.write)?.service).toBe("Google Calendar");
  });
});

describe("2. needs a look comes first", () => {
  it("orders unverified, failed, and destructive lines ahead of verified changes and lookups", () => {
    const lines = condenseLines([
      story("read", "Slack", "proxy", false, "1 lookup"),
      story("created", "Notion", "verified", true, "Created page 'Launch'"),
      story("changed", "Slack", "proxy", true, "Changed access", { tool: "update_permission", verb: "update" }),
      story("failed", "Notion", "proxy", false, "Failed in Notion."),
      story("changed", "Google Calendar", "claim", true, "Moved the call"),
    ], { detail: false });
    expect(lines.map((line) => line.summary)).toEqual([
      "Moved the call",
      "Failed in Notion.",
      "Changed access",
      "Created page 'Launch'",
      "1 lookup",
    ]);
    expect(lines.map((line) => line.trust ? trustColor(line) : "")).toContain("#8d1c1c");
  });
});

describe("3. plain-language trust badges", () => {
  it("names who checked the line", () => {
    expect(trustLabel("verified", "github")).toBe("Verified in GitHub");
    expect(trustLabel("proxy", "gmail")).toBe("Sent to Gmail, not verified");
    expect(trustLabel("claim", "google_calendar")).toBe("Agent says it did this, not verified");
    const reads = condenseLines([
      story("read", "DeepWiki", "proxy", false, "Looked up the docs."),
      story("read", "DeepWiki", "proxy", false, "Looked up a page."),
      story("read", "DeepWiki", "proxy", false, "Looked up a question."),
    ], { detail: false });
    expect(reads[0]?.summary).toBe("3 lookups");
  });
});

describe("4. the object, the link, and undo", () => {
  it("prints before and after, a link, and whether undo exists", async () => {
    expect(claimSentence({
      tool: "google_calendar",
      target: "Design Sync",
      tone: "changed",
      verb: "move",
      before: "Tue 2:00 PM",
      after: "Thu 3:00 PM",
    })).toBe('Moved "Design Sync" · Tue 2:00 PM → Thu 3:00 PM');
    const book = new SessionBook();
    const deps = base(book);
    await startSession(deps, {});
    await logAction(deps, {
      tool: "google_calendar",
      action: "modified",
      target: "Design Sync",
      before: "Tue 2:00 PM",
      after: "Thu 3:00 PM",
      url: "https://calendar.google.com/calendar/event?eid=abc",
    });
    const ended = await endSession(deps, {});
    const lines = condenseLines(storyFromReceipt(ended.receipt), { detail: false });
    const line = lines.find((item) => item.summary.includes("Design Sync"));
    expect(line?.summary).toBe('Moved "Design Sync" · Tue 2:00 PM → Thu 3:00 PM');
    expect(line?.link).toBe("https://calendar.google.com/calendar/event?eid=abc");
    expect(line?.hint).toBe("Undo not available yet");
    expect(line?.undo).toBeUndefined();
  });
});

describe("5. quiet when nothing changed", () => {
  it("returns one line and still keeps the receipt", async () => {
    const book = new SessionBook();
    const meta = new MemoryMetadataStore();
    const deps = base(book, meta);
    await startSession(deps, {});
    await recordProxyCall(deps, {
      upstream: "deepwiki",
      tool: "read_wiki_structure",
      args: { repoName: "facebook/react" },
      ok: true,
      status: "ok",
      summary: "Looked up the docs.",
      classification: { effect: "read", tone: "read", verb: "read" },
      durationMs: 3,
    });
    await recordProxyCall(deps, {
      upstream: "notes",
      tool: "list_pages",
      args: { query: "today" },
      ok: true,
      status: "ok",
      summary: "Listed pages.",
      classification: { effect: "read", tone: "read", verb: "list" },
      durationMs: 3,
    });
    const ended = await endSession(deps, {});
    const shown = await receiptPresentation(deps, ended.receipt, `https://lifediff.dev/receipts/${ended.receipt.id}`);
    expect(shown.quiet).toBe(true);
    expect(shown.markdown).toBe("Nothing changed · 2 lookups");
    expect(shown.markdown).not.toContain("Full receipt");
    expect(shown.markdown).not.toContain("GitHub not checked");
    expect(shown.imageUrl).toContain("/card.png?t=");
    expect(meta.receipts.size).toBe(1);
    expect(isQuiet(shown.lines)).toBe(true);
    const day = await buildRoundup({ ...deps, issuer: "https://lifediff.dev" }, { save: false });
    expect(day.quiet).toBe(true);
    expect(day.markdown).toBe("Nothing changed · 2 lookups");
  });
});

describe("6. cards name the service and keep color", () => {
  it("puts the service and trust on each change, with amber, red, and green", async () => {
    const lines = condenseLines([
      story("changed", "google_calendar", "claim", true, 'Moved "Design Sync"'),
      story("removed", "gmail", "proxy", true, "Sent 'Notes for Friday'", { verb: "send", tool: "send_message" }),
      story("created", "github", "verified", true, "Opened pull request 'Fix login'"),
    ], { detail: false });
    const rows = cardRows(lines);
    expect(rows.map((row) => row.source)).toEqual(["claim", "proxy", "verified"]);
    expect(rows[0]?.text).toContain("Google Calendar");
    expect(rows[0]?.text).toContain("Agent says it did this, not verified");
    expect(rows[1]?.text).toContain("Gmail");
    expect(rows[1]?.text).toContain("Sent to Gmail, not verified");
    expect(rows[2]?.text).toContain("GitHub");
    expect(rows[2]?.text).toContain("Verified in GitHub");
    expect(rows.map((row) => row.color)).toEqual(["#6b4300", "#8d1c1c", "#0f5c32"]);
    const png = await renderCardPng(lines, "Life Diff", "This session");
    const pixels = await decodePng(png);
    expect(hasColor(pixels.rgb, [107, 67, 0])).toBe(true);
    expect(hasColor(pixels.rgb, [141, 28, 28])).toBe(true);
    expect(hasColor(pixels.rgb, [15, 92, 50])).toBe(true);
  });
});

describe("7. soft errors", () => {
  it("records an obvious error payload as a failure", async () => {
    expect(toolFailure({ isError: true, content: [{ type: "text", text: "nope" }] }).failed).toBe(true);
    expect(toolFailure({ content: [{ type: "text", text: "Error: quota exceeded" }] }).failed).toBe(true);
    expect(toolFailure({ content: [{ type: "text", text: '{"error":"nope"}' }] }).failed).toBe(true);
    expect(toolFailure({ content: [{ type: "text", text: "Saved with no error." }] }).failed).toBe(false);
    const book = new SessionBook();
    const deps = base(book);
    const target = { name: "notes", url: "https://mcp.example/mcp" };
    await forwardToolCall(deps, toolFetch({ content: [{ type: "text", text: "Error: quota exceeded" }] }), target, "create_page", { title: "Launch" });
    const logged = book.list(book.getOpen()!.id);
    expect(logged[0]?.ok).toBe(false);
    expect(logged[0]?.summary).toBe("Failed in Notes.");
    const ended = await endSession(deps, {});
    const lines = condenseLines(storyFromReceipt(ended.receipt), { detail: false });
    expect(lines[0]?.tone).toBe("failed");
    expect(lines[0]?.summary).toContain("Failed in Notes");
  });
});

describe("8. secret redaction", () => {
  it("redacts nested secret keys and caps the stored result", async () => {
    const nested = redactSnippet(JSON.stringify({
      title: "Q2",
      nested: { api_key: "sekret-key", password: "hunter2", note: "keep me" },
    }));
    expect(nested).not.toContain("sekret-key");
    expect(nested).not.toContain("hunter2");
    expect(nested).toContain("keep me");
    expect(nested).toContain("[redacted]");
    const book = new SessionBook();
    const deps = base(book);
    const logged = await recordProxyCall(deps, {
      upstream: "notes",
      tool: "create_page",
      args: { title: "Q2", nested: { api_key: "sekret-key", note: "keep me" } },
      ok: true,
      status: "ok",
      summary: "Created page.",
      classification: classifyToolName("create_page"),
      durationMs: 4,
      result: JSON.stringify({ password: "hunter2", title: "Q2", blob: "x".repeat(800) }),
    });
    expect(JSON.stringify(logged.arguments)).not.toContain("sekret-key");
    expect(JSON.stringify(logged.arguments)).toContain("keep me");
    expect(logged.result).not.toContain("hunter2");
    expect(logged.result!.length).toBeLessThanOrEqual(240);
  });
});

describe("9. daily totals drop a duplicate stored read", () => {
  it("counts a proxy read once when an older claim was stored beside it", async () => {
    const meta = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    const book = new SessionBook();
    await meta.saveSettings("42", {
      timeZone: "UTC",
      dayEnd: "18:00",
      githubDaily: false,
      idleMinutes: 20,
      quietDays: false,
    }, now.toISOString());
    const receipt = receiptWith([
      readAction("real", "deepwiki", "read_wiki_structure", { repoName: "facebook/react" }, "Looked up the docs outline for facebook/react in DeepWiki."),
      readAction("dup", "deepwiki", "deepwiki", { subject: "facebook/react wiki structure" }, "Looked up facebook/react wiki structure in DeepWiki."),
    ], []);
    await objects.put("receipts/42/rcpt_old.json", JSON.stringify(receipt), "application/json");
    await objects.put("receipts/42/rcpt_old.html", "<p></p>", "text/html");
    await meta.insertReceipt({
      id: "rcpt_old",
      userId: "42",
      sessionId: "ses_old",
      createdAt: now.toISOString(),
      expiresAt: "2026-07-01T00:00:00.000Z",
      jsonKey: "receipts/42/rcpt_old.json",
      htmlKey: "receipts/42/rcpt_old.html",
      added: 0,
      removed: 0,
      modified: 0,
      verifiedClaims: 0,
      missingClaims: 0,
      unclaimedChanges: 0,
    });
    const day = await buildRoundup({ ...base(book, meta), objects, issuer: "https://lifediff.dev" }, { save: false });
    expect(day.markdown).toBe("Nothing changed · 1 lookup");
  });
});

function story(
  tone: StoryLine["tone"],
  service: string,
  source: StoryLine["source"],
  write: boolean,
  summary: string,
  extra?: { verb?: string; tool?: string },
): StoryLine {
  return {
    service,
    source,
    write,
    tone,
    summary,
    seed: summary,
    trust: trustLabel(source, service),
    ...(tone === "read" ? { readCount: 1 } : {}),
    ...(extra?.verb ? { verb: extra.verb } : {}),
    ...(extra?.tool ? { tool: extra.tool } : {}),
  };
}

function trustColor(line: StoryLine): string {
  return line.tone === "failed" || line.tone === "removed" ? "#8d1c1c" : "#6b4300";
}

function readAction(id: string, upstream: string, tool: string, args: Record<string, unknown>, summary: string): RecordedAction {
  return {
    id,
    time: now.toISOString(),
    upstream,
    tool,
    summary,
    tone: "read",
    effect: "read",
    ok: true,
    status: "ok",
    arguments: args,
    source: "proxy",
  };
}

function receiptWith(actions: RecordedAction[], claims: Receipt["claims"]): Receipt {
  return {
    schemaVersion: "1.0.0",
    id: "rcpt_old",
    generatedAt: now.toISOString(),
    readOnly: true,
    producer: { name: "lifediff-hosted", version: "0.1.0" },
    snapshot: { id: "none", takenAt: now.toISOString() },
    comparedAt: now.toISOString(),
    timeZone: "UTC",
    session: { startedAt: now.toISOString(), checkedAt: now.toISOString() },
    github: { repos: [], diffMode: "snapshot", truncatedSnapshot: false, truncatedChanges: false, suppressedRemovals: false },
    counts: { added: 0, removed: 0, modified: 0, verifiedClaims: 0, missingClaims: claims.length, unclaimedChanges: 0 },
    claimsChecked: claims.length > 0,
    claims,
    notes: [],
    changes: [],
    actions,
  };
}

function base(book: SessionBook, meta = new MemoryMetadataStore()) {
  meta.saveSettings("42", {
    timeZone: "UTC",
    dayEnd: "18:00",
    githubDaily: false,
    idleMinutes: 20,
    quietDays: false,
  }, now.toISOString());
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

function quietGithub(): GitHubApi {
  const fail = async (): Promise<never> => {
    throw new Error("GitHub should not be called");
  };
  return {
    listInstallations: fail,
    listInstallationRepos: fail,
    listBranches: fail,
    listPulls: fail,
    listIssues: fail,
    listCommits: fail,
    compare: fail,
    listIssueComments: fail,
    listReviewComments: fail,
  };
}

function toolFetch(result: unknown): typeof fetch {
  return async (_input, init) => {
    const message = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } });
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, result });
    return new Response(`event: message\ndata: ${body}\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
}

function hasColor(rgb: Uint8Array, color: [number, number, number]): boolean {
  for (let i = 0; i < rgb.length; i += 3) {
    if (rgb[i] === color[0] && rgb[i + 1] === color[1] && rgb[i + 2] === color[2]) return true;
  }
  return false;
}

async function decodePng(png: Uint8Array): Promise<{ rgb: Uint8Array }> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const parts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4] ?? 0, png[offset + 5] ?? 0, png[offset + 6] ?? 0, png[offset + 7] ?? 0);
    if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
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
  return { rgb };
}
