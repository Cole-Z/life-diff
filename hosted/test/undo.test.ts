import { describe, expect, it } from "vitest";
import { endSession, getReceipt, logAction, requestUndo, sessionPortFromBook, startSession } from "../src/app/service";
import { handleData } from "../src/http/data";
import { createLifeDiffServer } from "../src/mcp/server";
import { classifyToolName } from "../src/proxy/classify";
import { actionsMatch, applyClaims, normalizeAction } from "../src/receipt/claims";
import { renderHtml } from "../src/receipt/html";
import { cardRows } from "../src/receipt/story";
import { condenseLines, footerFor, renderStory, storyFromReceipt, summaryChips, summaryText, type StoryLine } from "../src/receipt/story";
import { reversalHint, undoPlan } from "../src/receipt/undo";
import { SessionBook } from "../src/session/book";
import { MemoryMetadataStore, MemoryObjectStore } from "../src/storage/memory";
import type { Env } from "../src/env";
import type { GitHubApi } from "../src/github/types";
import type { Change } from "../src/receipt/types";

const now = new Date("2026-04-02T15:00:00.000Z");

describe("kind mapping", () => {
  it("maps move, rename, share, and trash without dropping modified", () => {
    expect(classifyToolName("move_event")).toMatchObject({ tone: "moved", verb: "move" });
    expect(classifyToolName("rename_file")).toMatchObject({ tone: "moved", verb: "rename" });
    expect(classifyToolName("share_file")).toMatchObject({ tone: "shared", verb: "share" });
    expect(classifyToolName("trash_file")).toMatchObject({ tone: "removed", verb: "trash" });
    expect(classifyToolName("update_event")).toMatchObject({ tone: "changed", verb: "update" });
    expect(normalizeAction("rename")).toBe("moved");
    expect(normalizeAction("share")).toBe("shared");
    expect(normalizeAction("trash")).toBe("removed");
    expect(normalizeAction("modified")).toBe("modified");
    expect(actionsMatch("moved", "modified")).toBe(true);
    expect(actionsMatch("shared", "modified")).toBe(true);
    expect(actionsMatch("moved", "added")).toBe(false);
    const applied = applyClaims([change("modified")], [{ service: "github", action: "moved", target: "README.md", repo: "acme/app" }]);
    expect(applied.claims[0]?.status).toBe("verified");
    expect(applied.claims[0]?.action).toBe("moved");
  });
});

describe("summary and footer counts", () => {
  it("shows only nonzero kinds", () => {
    const chips = summaryChips([
      row({ tone: "created", summary: "Dentist added" }),
      row({ tone: "removed", summary: "a" }),
      row({ tone: "removed", summary: "b" }),
      row({ tone: "removed", summary: "c" }),
      row({ tone: "moved", summary: "Standup moved" }),
      row({ tone: "shared", summary: "Budget sheet shared" }),
      row({ tone: "read", summary: "1 lookup", write: false }),
      row({ tone: "failed", summary: "Quota exceeded", write: false }),
    ]);
    expect(chips.map((chip) => chip.kind)).toEqual(["added", "removed", "moved", "shared"]);
    expect(summaryText(chips.length ? [
      row({ tone: "created", summary: "Dentist added" }),
      row({ tone: "removed", summary: "a" }),
      row({ tone: "removed", summary: "b" }),
      row({ tone: "removed", summary: "c" }),
      row({ tone: "moved", summary: "Standup moved" }),
      row({ tone: "shared", summary: "Budget sheet shared" }),
    ] : [])).toBe("+1 added  −3 removed  →1 moved  ↗1 shared");
  });

  it("counts claimed, found, not found, not checked, and lookups", () => {
    const text = footerFor([
      row({ tone: "created", source: "verified", claimed: true, summary: "Opened the pull request" }),
      row({ tone: "not_found", source: "claim", write: false, summary: '"Renamed the Q4 folder": no matching change' }),
      row({ tone: "not_checked", source: "claim", write: false, summary: "Budget sheet shared with a new person" }),
      row({ tone: "failed", source: "proxy", write: false, summary: "Quota exceeded" }),
      row({ tone: "read", source: "proxy", write: false, summary: "3 lookups", readCount: 3 }),
    ]);
    expect(text).toBe("Agent claimed 3 things · 1 found in your accounts · 1 not found · 1 not checked · 3 lookups");
  });
});

describe("undo prompts", () => {
  it("writes a plain instruction and a suggested call, and does not unsend a message", () => {
    const moved = undoPlan({
      tool: "update_event",
      upstream: "google_calendar",
      verb: "move",
      tone: "moved",
      summary: "Standup",
      before: "9:30 AM",
      after: "10:00 AM",
      arguments: { title: "Standup", before: "9:30 AM", after: "10:00 AM" },
    });
    expect(moved?.prompt).toBe('Move "Standup" back to 9:30 AM on Google Calendar.');
    expect(moved?.tool).toBe("update_event");
    expect(moved?.suggestedTool).toBe("update_event");
    expect(moved?.suggestedArguments).toMatchObject({ before: "10:00 AM", after: "9:30 AM" });

    const trashed = undoPlan({
      tool: "trash_file",
      upstream: "google_drive",
      verb: "trash",
      tone: "removed",
      summary: "3 files",
      arguments: { title: "3 files" },
      time: "2026-04-02T15:00:00.000Z",
      now: "2026-04-03T15:00:00.000Z",
    });
    expect(trashed?.prompt).toBe("Restore the 3 files from Google Drive trash.");
    expect(trashed?.suggestedTool).toBe("restore_file");
    expect(trashed?.daysLeft).toBe(29);

    const shared = undoPlan({
      tool: "share_file",
      upstream: "google_drive",
      verb: "share",
      tone: "shared",
      summary: "Budget sheet",
      arguments: { title: "Budget sheet" },
    });
    expect(shared?.prompt).toBe('Stop sharing "Budget sheet" with the new person in Google Drive.');
    expect(shared?.suggestedTool).toBe("unshare_file");

    const sent = undoPlan({
      tool: "send_message",
      upstream: "gmail",
      verb: "send",
      tone: "removed",
      summary: "Notes for Friday",
    });
    expect(sent?.prompt).toContain("cannot be unsent");
    expect(reversalHint({ tool: "send_message", upstream: "gmail", verb: "send", tone: "removed", effect: "write" })).toBeUndefined();
  });
});

describe("undo_change and undo_session", () => {
  it("returns the prompt, records that an undo was requested, and does not claim it happened", async () => {
    const book = new SessionBook();
    const deps = base(book);
    await startSession(deps, {});
    await logAction(deps, {
      tool: "google_calendar",
      action: "moved",
      target: "Standup",
      before: "9:30 AM",
      after: "10:00 AM",
    });
    await logAction(deps, {
      tool: "google_drive",
      action: "shared",
      target: "Budget sheet",
    });
    const ended = await endSession(deps, {});
    expect(ended.html).toContain("Undo session");
    expect(ended.html).toContain("Copy undo prompt");
    expect(ended.html).toContain("kind-moved");
    expect(ended.html).toContain("kind-shared");
    const plans = await requestUndo(deps, { receiptId: ended.receipt.id, origin: "https://lifediff.dev" });
    expect(plans.recorded).toBe("undo requested");
    expect(plans.undos).toHaveLength(2);
    expect(plans.undos.every((item) => item.requested)).toBe(true);
    const again = await getReceipt(deps, ended.receipt.id);
    expect(again.html).toContain("Undo requested");
    expect(again.receipt.undoRequestedSeeds?.length).toBe(2);
    const after = condenseLines(storyFromReceipt(again.receipt), { detail: false });
    const afterStory = renderStory({
      headline: "",
      lines: after,
      link: `https://lifediff.dev/receipts/${ended.receipt.id}`,
      linkLabel: "Full receipt",
    });
    expect(afterStory).toContain("Undo requested");
    expect(afterStory).not.toContain("[Undo](");
    expect(cardRows(after).map((row) => row.text).join("\n")).toContain("Undo requested");
    expect(JSON.stringify(again.receipt)).toContain("undoRequestedSeeds");
    expect(plans.undos.map((item) => item.prompt).join("\n")).toContain("Standup");
    expect(plans.undos.every((item) => item.url.includes(`/receipts/${ended.receipt.id}/undo/`))).toBe(true);
    const one = await requestUndo(deps, { receiptId: ended.receipt.id, changeId: plans.undos[0]?.changeId, origin: "https://lifediff.dev" });
    expect(one.undos).toHaveLength(1);
    expect(one.recorded).toBe("undo requested");
    const open = book.getOpen();
    const logged = open ? book.list(open.id).find((action) => action.tool === "undo_request") : undefined;
    expect(logged?.status).toBe("undo_requested");
    expect(logged?.effect).toBe("read");
    expect(logged?.summary).toContain("Life Diff did not run it");
    expect(logged?.summary?.toLowerCase()).not.toContain("undo happened");
    await expect(requestUndo(deps, { receiptId: ended.receipt.id, changeId: "missing", origin: "https://lifediff.dev" })).rejects.toThrow(/not on this receipt/);
    const follow = await endSession(deps, {});
    const recorded = JSON.stringify(follow.receipt.actions);
    expect(recorded).toContain("Undo requested");
    expect(recorded).toContain("Life Diff did not run it");
    expect(recorded.toLowerCase()).not.toContain("undo happened");
    expect(renderHtml(ended.receipt)).toContain("Move");
    const story = renderStory({
      headline: "",
      lines: condenseLines(storyFromReceipt(ended.receipt), { detail: false }),
      link: `https://lifediff.dev/receipts/${ended.receipt.id}`,
      linkLabel: "Full receipt",
    });
    expect(story).toContain(`[Undo](https://lifediff.dev/receipts/${ended.receipt.id}/undo/`);
    expect(story).not.toContain("undo happened");
  });

  it("registers the tools and refuses them without a signed-in user", async () => {
    const server = await createLifeDiffServer({
      ISSUER: "https://lifediff.dev",
      MCP_SERVER_URL: "https://lifediff.dev/mcp",
    } as Env);
    const tools = (server as unknown as { _registeredTools: Record<string, { description?: string; handler: (input: { receiptId: string; changeId?: string }) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools;
    expect(tools.undo_change?.description).toContain("does not run the undo");
    expect(tools.undo_session?.description).toContain("does not run");
    const denied = await tools.undo_change?.handler({ receiptId: "rcpt_demo", changeId: "ab" });
    expect(denied?.isError).toBe(true);
    expect(denied?.content[0]?.text).toContain("Sign in");
    const deniedSession = await tools.undo_session?.handler({ receiptId: "rcpt_demo" });
    expect(deniedSession?.isError).toBe(true);
  });
});

describe("undo route auth", () => {
  it("requires the same sign-in as a receipt", async () => {
    const env = {} as Env;
    const one = await handleData(new Request("https://lifediff.dev/receipts/rcpt_demo/undo/ab"), env);
    const all = await handleData(new Request("https://lifediff.dev/receipts/rcpt_demo/undo"), env);
    expect(one.status).toBe(401);
    expect(all.status).toBe(401);
    expect(await one.text()).toContain("Sign in");
    const bearer = await handleData(new Request("https://lifediff.dev/receipts/rcpt_demo/undo/ab", {
      headers: { authorization: "Bearer not-a-token" },
    }), { AUTH_SERVER: { validateToken: () => Promise.resolve(null) } } as unknown as Env);
    expect(bearer.status).toBe(401);
  });
});

function row(partial: Partial<StoryLine> & Pick<StoryLine, "tone" | "summary">): StoryLine {
  return {
    service: "GitHub",
    source: "proxy",
    write: true,
    seed: partial.summary,
    ...partial,
  };
}

function change(kind: Change["kind"]): Change {
  return {
    id: "chg_1",
    service: "github",
    kind,
    resourceId: "file:acme/app:README.md",
    resourceName: "README.md",
    summary: "Modified README.md",
    fields: [],
    confidence: "high",
    confidenceReason: "during the session",
    resourceType: "file",
    repo: "acme/app",
  };
}

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
