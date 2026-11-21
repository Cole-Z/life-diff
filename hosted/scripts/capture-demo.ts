import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { renderCardPng } from "../src/receipt/card";
import { renderHtml } from "../src/receipt/html";
import { renderDiffPage } from "../src/receipt/page";
import { condenseLines, headlineFor, renderStory, storyFromReceipt } from "../src/receipt/story";
import type { Receipt, RecordedAction } from "../src/receipt/types";

const when = "2026-04-02T15:00:00.000Z";

const actions: RecordedAction[] = [
  action("cal", "google_calendar", "create_event", { title: "Team standup", url: "https://calendar.google.com/calendar/r/eventedit/demo" }, "Grok Bot"),
  action("drive", "google_drive", "rename_file", { title: "Q2 plan", name: "Q2 plan", previous: { title: "Q2 goals" }, url: "https://drive.google.com/file/d/demo/view" }, "Cursor"),
  action("mail", "gmail", "send_draft", { title: "Notes for Friday", url: "https://mail.google.com/mail/u/0/#drafts/demo" }, "Grok Bot"),
  action("fail", "notion", "create_page", { title: "Launch checklist" }, "Cursor", false, "The page was not saved."),
  action("w1", "deepwiki", "read_wiki_structure", { repoName: "vercel/next.js" }, "Grok Bot"),
  action("w2", "deepwiki", "read_wiki_contents", { repoName: "vercel/next.js" }, "Grok Bot"),
  action("w3", "slack", "list_channels", { query: "product" }, "Cursor"),
];

const receipt: Receipt = {
  schemaVersion: "1.0.0",
  id: "rcpt_demo",
  generatedAt: when,
  readOnly: true,
  producer: { name: "lifediff-hosted", version: "0.1.0" },
  snapshot: { id: "snap_demo", takenAt: when },
  comparedAt: "2026-04-02T15:20:00.000Z",
  timeZone: "America/Los_Angeles",
  session: { startedAt: when, checkedAt: "2026-04-02T15:20:00.000Z" },
  github: { repos: ["cole-z/cardpost"], diffMode: "snapshot", truncatedSnapshot: false, truncatedChanges: false, suppressedRemovals: false, optIn: true },
  counts: { added: 1, removed: 0, modified: 0, verifiedClaims: 1, missingClaims: 0, unclaimedChanges: 0 },
  claimsChecked: false,
  claims: [],
  notes: ["A proxied call is not proof the service changed. Verified lines come from a service that exposes history, such as GitHub."],
  actions,
  changes: [{
    id: "pr12",
    service: "github",
    kind: "added",
    resourceId: "pull:cole-z/cardpost:12",
    resourceName: "Fix login",
    summary: "Opened pull request \"Fix login\" (#12) on cole-z/cardpost.",
    fields: [{ field: "title", label: "Title", before: "", after: "Fix login" }, { field: "status", label: "Status", before: "", after: "open" }],
    confidence: "high",
    confidenceReason: "during the session",
    resourceType: "pull_request",
    repo: "cole-z/cardpost",
    link: "https://github.com/cole-z/cardpost/pull/12",
    occurredAt: "2026-04-02T15:10:00.000Z",
  }],
};

const lines = condenseLines(storyFromReceipt(receipt), { detail: false });
const sessionHtml = renderHtml(receipt);
const dailyHtml = renderDiffPage({
  title: "Life Diff 2026-04-02",
  lede: "What your agents changed.",
  headline: headlineFor(lines, "Today"),
  when: "2026-04-02 · America/Los_Angeles · day ends 18:00",
  lines,
  footer: "Life Diff records tool calls routed through it. GitHub is the sign-in, plus an optional check when you turn it on and name the repositories.",
});
const markdown = renderStory({
  headline: headlineFor(lines, "This session"),
  lines,
  link: "https://lifediff.dev/receipts/rcpt_demo",
  linkLabel: "Full receipt",
});
const daily = renderStory({
  headline: headlineFor(lines, "Today"),
  lines,
  link: "https://lifediff.dev/roundup/2026-04-02",
  linkLabel: "Full day",
});
const png = await renderCardPng(lines, "Life Diff", "This session");

const out = new URL("../../docs/images/", import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL("card.png", out), png);
await writeFile(new URL("session.md", out), markdown);
await writeFile(new URL("daily.md", out), daily);

const browser = await chromium.launch();
await shoot(browser, sessionHtml, "light", new URL("receipt-light.png", out));
await shoot(browser, sessionHtml, "dark", new URL("receipt-dark.png", out));
await shoot(browser, dailyHtml, "light", new URL("daily.png", out));
await browser.close();
process.stdout.write(`${markdown}\n---\n${daily}\n`);

function action(id: string, upstream: string, tool: string, args: Record<string, unknown>, client: string, ok = true, error?: string): RecordedAction {
  return {
    id,
    time: when,
    upstream,
    tool,
    summary: "",
    tone: ok ? "unknown" : "failed",
    effect: "unknown",
    ok,
    status: ok ? "ok" : "error",
    arguments: args,
    source: "proxy",
    client,
    ...(error ? { error } : {}),
  };
}

async function shoot(browser: Awaited<ReturnType<typeof chromium.launch>>, html: string, scheme: "light" | "dark", path: URL): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 }, colorScheme: scheme, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: path.pathname, fullPage: true });
  await page.close();
}
