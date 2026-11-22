import { describe, expect, it } from "vitest";
import { endSession, logAction, requestUndo, sessionPortFromBook, startSession } from "../src/app/service";
import { CARD_SYMBOLS, cardPlain, cardSymbolsCovered, glyphKey } from "../src/receipt/card";
import { readViewGrant, signViewGrant, VIEW_TTL_SECONDS, viewUrl } from "../src/crypto/view-token";
import { handleData } from "../src/http/data";
import { handleRoundup } from "../src/http/roundup";
import { plainSummary } from "../src/receipt/build";
import { summaryFor } from "../src/receipt/roundup";
import { agentTitle, cardLineText, condenseLines, footerFor, renderStory, storyFromReceipt, storySummary } from "../src/receipt/story";
import { SessionBook } from "../src/session/book";
import { MemoryMetadataStore, MemoryObjectStore } from "../src/storage/memory";
import type { Env } from "../src/env";
import type { GitHubApi } from "../src/github/types";

const now = new Date("2026-04-02T15:00:00.000Z");
const KEY = "k".repeat(40);

describe("undo only for real changes", () => {
  it("drops the phantom claim and the duplicate of a logged change", async () => {
    const book = new SessionBook();
    const deps = base(book);
    await startSession(deps, {});
    await logAction(deps, { tool: "github", action: "added", target: "Fix login", repo: "acme/app" });
    const ended = await endSession(deps, {
      claims: [
        { service: "github", action: "added", target: "Fix login", repo: "acme/app" },
        { service: "github", action: "added", target: "Phantom PR", repo: "acme/app" },
      ],
    });
    const lines = condenseLines(storyFromReceipt(ended.receipt), { detail: false });
    const prompts = lines.filter((line) => line.undo);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.summary.toLowerCase()).toContain("fix login");
    expect(lines.filter((line) => line.summary.toLowerCase().includes("fix login"))).toHaveLength(1);
    const phantom = lines.find((line) => line.summary.toLowerCase().includes("phantom"));
    expect(phantom?.tone).toBe("not_checked");
    expect(phantom?.undo).toBeUndefined();
    expect(phantom?.hint).toBe("Undo not available");
    expect(renderStory({
      headline: "",
      lines,
      link: `https://lifediff.dev/receipts/${ended.receipt.id}`,
      linkLabel: "Full receipt",
    })).toContain("Undo not available");
    expect(phantom?.id).toBeTruthy();
    await expect(requestUndo(deps, { receiptId: ended.receipt.id, changeId: phantom?.id, origin: "https://lifediff.dev" })).rejects.toThrow(/Undo is not available/);
    const session = await requestUndo(deps, { receiptId: ended.receipt.id, origin: "https://lifediff.dev" });
    expect(session.undos).toHaveLength(1);
    expect(session.undos.map((item) => item.prompt).join("\n")).not.toContain("Phantom");
  });
});

describe("claim merge and footer", () => {
  it("counts a logged change and a matching claim once", async () => {
    const book = new SessionBook();
    const deps = base(book);
    await startSession(deps, {});
    for (const target of ["One", "Two", "Three", "Four", "Five"]) {
      await logAction(deps, { tool: "notion", action: "added", target });
    }
    const ended = await endSession(deps, {
      claims: [
        { service: "notion", action: "added", target: "one" },
        { service: "notion", action: "added", target: "Sixth" },
        { service: "notion", action: "added", target: "Seventh" },
      ],
    });
    const lines = condenseLines(storyFromReceipt(ended.receipt), { detail: false });
    const rows = lines.filter((line) => line.tone !== "read" && line.tone !== "note");
    expect(rows).toHaveLength(7);
    expect(lines.filter((line) => line.summary.toLowerCase().includes("one"))).toHaveLength(1);
    expect(footerFor(lines)).toBe("Agent claimed 7 things · 7 not checked");
    expect(lines.filter((line) => line.tone === "not_checked")).toHaveLength(2);
  });
});

describe("summary parity", () => {
  it("uses the same kind counts and trust words as the markdown", async () => {
    const book = new SessionBook();
    const deps = base(book);
    await startSession(deps, {});
    await logAction(deps, { tool: "notion", action: "added", target: "Launch page" });
    await logAction(deps, { tool: "google_calendar", action: "moved", target: "Standup", before: "9:30 AM", after: "10:00 AM" });
    const ended = await endSession(deps, {
      claims: [{ service: "github", action: "added", target: "Missing PR" }],
    });
    const lines = condenseLines(storyFromReceipt(ended.receipt), { detail: false });
    const summary = storySummary(lines);
    const markdown = renderStory({
      headline: "",
      lines,
      link: `https://lifediff.dev/receipts/${ended.receipt.id}`,
      linkLabel: "Full receipt",
    });
    expect(summary).toEqual(summaryFor(ended.receipt));
    expect(summary.text).toBe("+1 added  →1 moved");
    expect(markdown).toContain(summary.text);
    expect(summary).toMatchObject({ added: 1, changed: 0, removed: 0, moved: 1, shared: 0, notChecked: 1, failed: 0 });
    expect(JSON.stringify(summary)).not.toMatch(/missing/i);
    expect(plainSummary(ended.receipt)).toContain("0 added, 0 removed, 0 modified");
    expect(plainSummary(ended.receipt)).toContain("missing");
    expect(summary.added + summary.moved).toBe(2);
  });
});

describe("not checked rows", () => {
  it("names the service", async () => {
    const book = new SessionBook();
    const deps = base(book);
    await startSession(deps, {});
    const ended = await endSession(deps, {
      claims: [{ service: "github", action: "added", target: "Phantom PR" }],
    });
    const line = condenseLines(storyFromReceipt(ended.receipt), { detail: false }).find((item) => item.tone === "not_checked");
    expect(line).toBeTruthy();
    const markdown = renderStory({
      headline: "",
      lines: line ? [line] : [],
      link: "https://lifediff.dev/receipts/rcpt",
      linkLabel: "Full receipt",
    });
    expect(markdown).toContain("Not checked · GitHub · Agent said");
    expect(cardLineText(line!)).toContain("Not checked · GitHub · Agent said");
    expect(ended.html).toContain("GitHub");
    expect(ended.html).toContain("Not checked");
  });
});

describe("card glyphs", () => {
  it("covers the symbols the markdown counts use", () => {
    expect(cardSymbolsCovered()).toBe(true);
    for (const symbol of CARD_SYMBOLS) {
      expect(glyphKey(symbol)).toBe(symbol);
      expect(cardPlain(`+1 ${symbol}`)).toContain(symbol);
    }
    expect(cardPlain("→")).not.toBe("->");
    expect(cardPlain("↗")).not.toBe(">");
    expect(cardPlain("−")).not.toBe("-");
    expect(cardPlain("~")).toBe("~");
  });
});

describe("session title", () => {
  it("uses the agent name from the session and falls back to Agent", async () => {
    const book = new SessionBook();
    const deps = base(book);
    await startSession(deps, { agentName: "Grok Bot" });
    await logAction(deps, { tool: "notion", action: "added", target: "Launch page" });
    const ended = await endSession(deps, {});
    const lines = condenseLines(storyFromReceipt(ended.receipt), { detail: false });
    expect(ended.receipt.agentName).toBe("Grok Bot");
    expect(agentTitle(lines, ended.receipt.timeZone, ended.receipt.session.startedAt, ended.receipt.session.checkedAt, ended.receipt.agentName)).toContain("Grok Bot");
    expect(agentTitle([], "UTC")).toBe("Agent");
  });
});

describe("signed view links", () => {
  it("signs one receipt or one day and expires", async () => {
    const issuedAt = 1_700_000_000;
    const receipt = await signViewGrant(KEY, { kind: "receipt", id: "rcpt_1", userId: "42" }, issuedAt);
    const day = await signViewGrant(KEY, { kind: "day", id: "2026-04-02", userId: "42" }, issuedAt);
    expect(await readViewGrant(KEY, receipt, issuedAt)).toMatchObject({ kind: "receipt", id: "rcpt_1", userId: "42" });
    expect(await readViewGrant(KEY, receipt, issuedAt + VIEW_TTL_SECONDS)).toBeNull();
    expect(await readViewGrant(KEY, `${receipt}x`, issuedAt)).toBeNull();
    expect(viewUrl("https://lifediff.dev", "receipt", "rcpt_1", receipt)).toBe(`https://lifediff.dev/receipts/rcpt_1?t=${encodeURIComponent(receipt)}`);
    expect(viewUrl("https://lifediff.dev", "day", "2026-04-02", day)).toContain("/roundup/2026-04-02?t=");
    const receiptPage = await handleData(new Request("https://lifediff.dev/receipts/rcpt_1?t=nope"), {} as Env);
    const dayPage = await handleRoundup(new Request("https://lifediff.dev/roundup/2026-04-02?t=nope"), {} as Env);
    expect(receiptPage.status).toBe(401);
    expect(dayPage.status).toBe(401);
    expect(await receiptPage.text()).toContain("expired");
    for (const response of [receiptPage, dayPage]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    const current = Math.floor(Date.now() / 1000);
    const validDay = await signViewGrant(KEY, { kind: "day", id: "2026-04-02", userId: "42" }, current);
    for (const path of ["/roundup", "/roundup/2026-04-03"]) {
      const mismatched = await handleRoundup(new Request(`https://lifediff.dev${path}?t=${validDay}`), { COOKIE_SIGNING_KEY: KEY } as Env);
      expect(mismatched.status).toBe(401);
    }
  });
});

function base(book: SessionBook) {
  return {
    userId: "42",
    login: "octocat",
    now,
    timeZone: "America/Chicago",
    maxRepos: 25,
    receiptRetentionDays: 90,
    snapshotRetentionHours: 24,
    abandonedSessionDays: 7,
    github: quietGithub(),
    sessions: sessionPortFromBook(book),
    meta: new MemoryMetadataStore(),
    objects: new MemoryObjectStore(),
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
