import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { renderCardPng } from "../src/receipt/card";
import { renderHtml } from "../src/receipt/html";
import { renderDiffPage } from "../src/receipt/page";
import { agentTitle, condenseLines, renderStory, storyFromReceipt } from "../src/receipt/story";
import type { Change, ClaimResult, Receipt, RecordedAction } from "../src/receipt/types";

const start = "2026-04-02T14:02:00.000Z";
const end = "2026-04-02T14:41:00.000Z";
const zone = "America/Chicago";

const actions: RecordedAction[] = [
  claim("cal", "google_calendar", "update_event", "moved", "Standup", "9:30", "10:00 AM", "2026-04-02T14:05:00.000Z"),
  claim("den", "google_calendar", "create_event", "created", "Dentist", undefined, "Tue 2:00 PM", "2026-04-02T14:12:00.000Z"),
  claim("file", "google_drive", "move_file", "moved", "Q3-receipts.xlsx moved to /Archive", undefined, undefined, "2026-04-02T14:18:00.000Z"),
  claim("trash", "google_drive", "trash_file", "removed", "3 files", undefined, undefined, "2026-04-02T14:22:00.000Z", "trash"),
  claim("share", "google_drive", "share_file", "shared", "Budget sheet", undefined, undefined, "2026-04-02T14:28:00.000Z"),
  claim("edit", "notion", "update_page", "changed", "Launch notes", "draft", "final", "2026-04-02T14:31:00.000Z", "update"),
  {
    id: "fail",
    time: "2026-04-02T14:33:00.000Z",
    upstream: "notion",
    tool: "create_page",
    summary: "Launch checklist",
    tone: "failed",
    effect: "write",
    verb: "create",
    ok: false,
    status: "error",
    source: "proxy",
    client: "Grok Bot",
    error: "Quota exceeded",
    arguments: { title: "Launch checklist" },
  },
  read("w1", "deepwiki", "read_wiki_structure", "2026-04-02T14:08:00.000Z"),
  read("w2", "deepwiki", "read_wiki_contents", "2026-04-02T14:09:00.000Z"),
  read("w3", "slack", "list_channels", "2026-04-02T14:36:00.000Z"),
];

const claims: ClaimResult[] = [
  {
    id: "claim-miss",
    service: "github",
    action: "moved",
    target: "Renamed the Q4 folder",
    status: "missing",
    reason: "No matching change showed up in GitHub.",
  },
  {
    id: "claim-notes",
    service: "notes",
    action: "added",
    target: "Call mom",
    status: "missing",
    reason: "Life Diff cannot check this service. This is what the agent reported.",
  },
];

const changes: Change[] = [{
  id: "pr12",
  service: "github",
  kind: "added",
  resourceId: "pull:cole-z/cardpost:12",
  resourceName: "Fix login",
  summary: "Opened pull request \"Fix login\" (#12) on cole-z/cardpost.",
  fields: [{ field: "title", label: "Title", before: "", after: "Fix login" }],
  confidence: "high",
  confidenceReason: "during the session",
  claimStatus: "verified",
  resourceType: "pull_request",
  repo: "cole-z/cardpost",
  link: "https://github.com/cole-z/cardpost/pull/12",
  occurredAt: "2026-04-02T14:30:00.000Z",
}];

const receipt: Receipt = {
  schemaVersion: "1.0.0",
  id: "rcpt_demo",
  generatedAt: end,
  readOnly: true,
  producer: { name: "lifediff-hosted", version: "0.1.0" },
  snapshot: { id: "snap_demo", takenAt: start },
  comparedAt: end,
  timeZone: zone,
  session: { startedAt: start, checkedAt: end },
  github: { repos: ["cole-z/cardpost"], diffMode: "snapshot", truncatedSnapshot: false, truncatedChanges: false, suppressedRemovals: false, optIn: true },
  counts: { added: 1, removed: 0, modified: 0, verifiedClaims: 1, missingClaims: 2, unclaimedChanges: 0 },
  claimsChecked: true,
  claims,
  notes: [
    "Verified means a service's own history matched the line. Agent said means Life Diff only has the agent's report.",
    "Sent to a service means Life Diff forwarded the call. That is not proof the service changed.",
    "An undo prompt is an instruction for the agent. Life Diff does not run it.",
  ],
  actions,
  changes,
};

const lines = condenseLines(storyFromReceipt(receipt), { detail: false });
const sessionHtml = renderHtml(receipt);
const dailyHtml = renderDiffPage({
  title: "Life Diff 2026-04-02",
  eyebrow: "TODAY",
  lines,
  timeZone: zone,
  receiptId: receipt.id,
  notes: ["Life Diff records tool calls routed through it. GitHub is the sign-in, plus an optional check when you turn it on and name the repositories."],
  footerNote: `2026-04-02 · ${zone}`,
});
const title = agentTitle(lines, zone, start, end);
const markdown = renderStory({
  headline: "",
  lines,
  link: "https://lifediff.dev/receipts/rcpt_demo",
  linkLabel: "Full receipt",
  eyebrow: "SESSION DIFF",
  title,
  timeZone: zone,
  startedAt: start,
  endedAt: end,
});
const daily = renderStory({
  headline: "",
  lines,
  link: "https://lifediff.dev/roundup/2026-04-02",
  linkLabel: "Full day",
  eyebrow: "TODAY",
  title: agentTitle(lines, zone),
  timeZone: zone,
});
const png = await renderCardPng(lines, title, "SESSION DIFF");

const out = new URL("../../docs/images/", import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL("card.png", out), png);

const browser = await chromium.launch();
await shoot(browser, sessionHtml, "light", new URL("receipt-light.webp", out));
await shoot(browser, sessionHtml, "dark", new URL("receipt-dark.webp", out));
await shoot(browser, dailyHtml, "light", new URL("daily.webp", out));
await shoot(browser, dailyHtml, "dark", new URL("daily-dark.webp", out));
await browser.close();
process.stdout.write(`${markdown}\n---\n${daily}\n`);

function claim(
  id: string,
  upstream: string,
  tool: string,
  tone: RecordedAction["tone"],
  target: string,
  before: string | undefined,
  after: string | undefined,
  time: string,
  verb?: string,
): RecordedAction {
  return {
    id,
    time,
    upstream,
    tool,
    summary: target,
    tone,
    effect: "write",
    verb: verb ?? (tone === "moved" ? "move" : tone === "shared" ? "share" : tone === "created" ? "create" : "delete"),
    ok: true,
    status: "ok",
    source: "claim",
    client: "Grok Bot",
    arguments: {
      title: target,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    },
  };
}

function read(id: string, upstream: string, tool: string, time: string): RecordedAction {
  return {
    id,
    time,
    upstream,
    tool,
    summary: "",
    tone: "read",
    effect: "read",
    ok: true,
    status: "ok",
    source: "proxy",
    client: "Grok Bot",
    arguments: { repoName: "vercel/next.js" },
  };
}

const exec = promisify(execFile);

async function shoot(browser: Awaited<ReturnType<typeof chromium.launch>>, html: string, scheme: "light" | "dark", path: URL): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 880, height: 900 }, colorScheme: scheme, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  const png = new URL(`${path.pathname}.png`);
  await page.screenshot({ path: png.pathname, fullPage: true });
  await page.close();
  await exec("ffmpeg", ["-y", "-i", png.pathname, "-c:v", "libwebp", "-quality", "84", path.pathname]);
  await unlink(png);
}
