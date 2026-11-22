import type { CoreDeps } from "../app/service";
import { redactStrings, redactText } from "../proxy/redact";
import { corroborateActions } from "./corroborate";
import { bytesToBase64, renderCardPng } from "./card";
import { renderDiffPage } from "./page";
import { coveredClaimIds } from "./merge";
import { agentTitle, chatText, condenseLines, headlineFor, isQuiet, storyFromActions, storyFromChanges, storyFromReceipt, storyFromUnverifiedClaims, storySummary, undoHref, visibleActions, type StoryLine, type StorySummary } from "./story";
import { dayWindow, localClock, type UserSettings } from "../time";
import type { Receipt } from "./types";

export interface Roundup {
  day: string;
  since: string;
  until: string;
  at: string;
  markdown: string;
  lines: StoryLine[];
  png: Uint8Array;
  html: string;
  cardToken?: string;
  finalized: boolean;
  quiet: boolean;
}

export function roundupJsonKey(userId: string): string {
  return `users/${userId}/roundup.json`;
}

export function dayJsonKey(userId: string, day: string): string {
  return `users/${userId}/days/${day}.json`;
}

export function roundupCardKey(token: string): string {
  return `roundups/${token}.png`;
}

interface StoredDay {
  day: string;
  at: string;
  since: string;
  until: string;
  markdown: string;
  lines: StoryLine[];
  cardToken: string;
  html: string;
}

export async function buildRoundup(deps: CoreDeps & { issuer: string }, input: {
  date?: string;
  since?: string;
  detail?: boolean;
  save: boolean;
  finalize?: boolean;
  markViewed?: boolean;
}): Promise<Roundup> {
  const settings = await deps.meta.getSettings(deps.userId);
  const today = localClock(deps.now, settings.timeZone).date;
  const day = resolveDay(input.date, today);
  const window = dayWindow(day, settings.timeZone);
  const after = resolveAfter(input.since, settings.lastViewedAt);
  const lines = await collectLines(deps, settings, window, input.detail === true, after);
  const existing = await deps.meta.getDaily(deps.userId, day);
  const previous = await loadStored(deps, day);
  const onlyLookups = lines.every((line) => line.tone === "read" || line.tone === "note" || line.tone === "unknown");
  const skipStore = settings.quietDays && onlyLookups;
  const token = input.save && !skipStore ? (previous?.cardToken ?? randomHex()) : previous?.cardToken;
  const origin = deps.issuer.replace(/\/$/, "");
  const page = `${origin}/roundup/${day}`;
  const label = day === today ? "Today" : day;
  const headline = headlineFor(lines, label);
  const heading = agentTitle(lines, settings.timeZone);
  const chat = chatText({
    headline,
    lines,
    link: page,
    linkLabel: "Full day",
    detail: input.detail === true,
    eyebrow: "TODAY",
    title: heading,
    timeZone: settings.timeZone,
  });
  const markdown = redactText(chat.markdown);
  const html = redactText(renderDiffPage({
    title: `Life Diff ${day}`,
    eyebrow: "TODAY",
    lines,
    timeZone: settings.timeZone,
    notes: ["Life Diff records tool calls routed through it. GitHub is the sign-in, plus an optional check when you turn it on and name the repositories."],
    footerNote: `${day} · ${settings.timeZone}`,
  }));
  const png = await renderCardPng(lines, heading, "TODAY");
  const finalizedAt = input.finalize ? (existing?.finalizedAt ?? deps.now.toISOString()) : existing?.finalizedAt;
  if (input.save && token && !skipStore) {
    const cardKey = roundupCardKey(token);
    if (existing?.cardKey && existing.cardKey !== cardKey) await deps.objects.delete([existing.cardKey]);
    await deps.objects.putBytes(cardKey, png, "image/png");
    const body: StoredDay = {
      day,
      at: deps.now.toISOString(),
      since: window.start,
      until: window.end,
      markdown,
      lines,
      cardToken: token,
      html,
    };
    await deps.objects.put(dayJsonKey(deps.userId, day), JSON.stringify(body), "application/json");
    await deps.objects.put(`users/${deps.userId}/days/${day}.html`, html, "text/html; charset=utf-8");
    await deps.meta.saveDaily({
      userId: deps.userId,
      day,
      jsonKey: dayJsonKey(deps.userId, day),
      htmlKey: `users/${deps.userId}/days/${day}.html`,
      cardKey,
      createdAt: existing?.createdAt ?? deps.now.toISOString(),
      updatedAt: deps.now.toISOString(),
      ...(finalizedAt ? { finalizedAt } : {}),
    });
  }
  if (input.markViewed) {
    await deps.meta.saveSettings(deps.userId, { ...settings, lastViewedAt: deps.now.toISOString() }, deps.now.toISOString());
  }
  return {
    day,
    since: window.start,
    until: window.end,
    at: deps.now.toISOString(),
    markdown,
    lines,
    png,
    html,
    finalized: Boolean(finalizedAt),
    ...(token ? { cardToken: token } : {}),
    quiet: chat.quiet,
  };
}

export async function loadRoundup(deps: CoreDeps & { issuer: string }, day?: string): Promise<Roundup | null> {
  const settings = await deps.meta.getSettings(deps.userId);
  const today = localClock(deps.now, settings.timeZone).date;
  const wanted = resolveDay(day, today);
  if (wanted === today) return null;
  const row = await deps.meta.getDaily(deps.userId, wanted);
  if (!row?.finalizedAt) return null;
  const stored = await loadStored(deps, wanted);
  if (!stored) return null;
  const png = row.cardKey ? await deps.objects.getBytes(row.cardKey) : null;
  return {
    day: stored.day,
    since: stored.since,
    until: stored.until,
    at: stored.at,
    markdown: redactText(stored.markdown),
    lines: redactStrings(stored.lines),
    png: png ?? new Uint8Array(),
    html: redactText(stored.html),
    finalized: true,
    cardToken: stored.cardToken,
    quiet: isQuiet(stored.lines),
  };
}

export async function receiptPresentation(deps: CoreDeps, receipt: Receipt, link: string): Promise<{ markdown: string; png: Uint8Array; imageUrl?: string; lines: StoryLine[]; quiet: boolean }> {
  const lines = condenseLines(storyFromReceipt(receipt), { detail: false });
  const imageUrl = receipt.cardToken ? `${link}/card.png?t=${receipt.cardToken}` : undefined;
  const chat = chatText({
    headline: headlineFor(lines, "This session"),
    lines,
    link,
    linkLabel: "Full receipt",
    eyebrow: "SESSION DIFF",
    title: agentTitle(lines, receipt.timeZone, receipt.session.startedAt, receipt.session.checkedAt, receipt.agentName),
    timeZone: receipt.timeZone,
    startedAt: receipt.session.startedAt,
    endedAt: receipt.session.checkedAt,
  });
  const title = agentTitle(lines, receipt.timeZone, receipt.session.startedAt, receipt.session.checkedAt, receipt.agentName);
  const png = await renderCardPng(lines, title, "SESSION DIFF");
  return { markdown: redactText(chat.markdown), png, lines, quiet: chat.quiet, ...(imageUrl ? { imageUrl } : {}) };
}

/** Lookup-only end_session stays one line and does not hand back a card. get_receipt still can. */
export function sessionToolPayload(input: {
  summary: StorySummary;
  receipt: Receipt;
  markdown: string;
  url: string;
  imageUrl?: string;
  quiet: boolean;
  html?: string;
  includeHtml?: boolean;
  viewUrl?: string;
}): Record<string, unknown> {
  const receipt = input.quiet ? omitCardToken(input.receipt) : input.receipt;
  const lines = condenseLines(storyFromReceipt(input.receipt), { detail: false });
  return {
    summary: input.summary,
    receipt,
    markdown: input.markdown,
    url: input.url,
    htmlUrl: input.viewUrl ?? input.url,
    ...(input.viewUrl ? { viewUrl: input.viewUrl } : {}),
    ...(!input.quiet && input.imageUrl ? { imageUrl: input.imageUrl } : {}),
    ...(input.includeHtml && input.html ? { html: input.html } : {}),
    undos: undoEntries(lines, input.url),
  };
}

export function summaryFor(receipt: Receipt): StorySummary {
  return storySummary(condenseLines(storyFromReceipt(receipt), { detail: false }));
}

export function undoEntries(lines: StoryLine[], link: string): { changeId: string; prompt: string; summary: string; service: string; url?: string; tool?: string; arguments?: Record<string, unknown>; suggestedTool?: string; suggestedArguments?: Record<string, unknown>; daysLeft?: number }[] {
  return lines.flatMap((line) => {
    if (!line.undo || !line.id) return [];
    const url = undoHref(link, line);
    return [{
      changeId: line.id,
      prompt: line.undo,
      summary: line.summary,
      service: line.service,
      ...(url ? { url } : {}),
      ...(line.undoTool ? { tool: line.undoTool } : {}),
      ...(line.undoArguments ? { arguments: line.undoArguments } : {}),
      ...(line.undoSuggestedTool ? { suggestedTool: line.undoSuggestedTool } : {}),
      ...(line.undoSuggestedArguments ? { suggestedArguments: line.undoSuggestedArguments } : {}),
      ...(line.undoDaysLeft ? { daysLeft: line.undoDaysLeft } : {}),
      ...(line.undoRequested ? { requested: true } : {}),
    }];
  });
}

function omitCardToken(receipt: Receipt): Receipt {
  const copy = { ...receipt };
  delete copy.cardToken;
  return copy;
}

export function pngContent(png: Uint8Array): { type: "image"; data: string; mimeType: "image/png" } | null {
  if (png.length < 8) return null;
  return { type: "image", data: bytesToBase64(png), mimeType: "image/png" };
}

async function collectLines(deps: CoreDeps, settings: UserSettings, window: { start: string; end: string }, detail: boolean, after?: string): Promise<StoryLine[]> {
  const through = deps.now.toISOString() < window.end ? new Date(deps.now.getTime() + 1000).toISOString() : window.end;
  const receipts = await deps.meta.listReceiptsBetween(deps.userId, window.start, through, 200);
  const raw: StoryLine[] = [];
  for (const meta of receipts) {
    const json = await deps.objects.get(meta.jsonKey);
    if (!json) continue;
    let receipt: Receipt;
    try {
      receipt = redactStrings(JSON.parse(json) as Receipt);
    } catch {
      continue;
    }
    const actions = visibleActions(receipt).filter((action) => action.time >= window.start && action.time < window.end && (!after || action.time >= after));
    const covered = coveredClaimIds(actions, receipt.claims);
    const requested = new Set(receipt.undoRequestedSeeds ?? []);
    const stamp = (line: StoryLine): StoryLine => ({
      ...line,
      receiptId: line.receiptId ?? receipt.id,
      ...(requested.has(line.seed) ? { undoRequested: true } : {}),
    });
    raw.push(...storyFromActions(actions).map(stamp));
    raw.push(...storyFromUnverifiedClaims(receipt.claims, new Set([...actions.map((action) => action.id), ...covered])).map(stamp));
    const stamped = receipt.generatedAt >= window.start && receipt.generatedAt < window.end;
    if (stamped && settings.githubDaily && receipt.github?.optIn === true) {
      const changes = after
        ? receipt.changes.filter((change) => !change.occurredAt || change.occurredAt >= after)
        : receipt.changes;
      raw.push(...storyFromChanges(receipt.id, changes).map(stamp));
    }
  }
  const open = await deps.sessions.getOpen();
  if (open) {
    const logged = await deps.sessions.list(open.id);
    const recorded = corroborateActions(logged).recorded.filter((action) => {
      if (action.time < window.start || action.time >= window.end) return false;
      if (after && action.time < after) return false;
      return true;
    });
    raw.push(...storyFromActions(recorded));
  }
  return condenseLines(dedupeSeeds(raw), { detail });
}

function dedupeSeeds(lines: StoryLine[]): StoryLine[] {
  const seen = new Set<string>();
  const out: StoryLine[] = [];
  for (const line of lines) {
    if (seen.has(line.seed)) continue;
    seen.add(line.seed);
    out.push(line);
  }
  return out;
}

function resolveAfter(since: string | undefined, lastViewedAt: string | undefined): string | undefined {
  if (!since?.trim()) return undefined;
  if (since.trim() === "last_viewed") return lastViewedAt;
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) throw new Error("since must be last_viewed or an ISO time.");
  return new Date(parsed).toISOString();
}

function resolveDay(requested: string | undefined, today: string): string {
  if (!requested?.trim()) return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested.trim())) throw new Error("date must be YYYY-MM-DD.");
  if (requested.trim() > today) throw new Error("date is still in the future.");
  return requested.trim();
}

async function loadStored(deps: CoreDeps, day: string): Promise<StoredDay | null> {
  const raw = await deps.objects.get(dayJsonKey(deps.userId, day));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredDay;
    if (!parsed || typeof parsed.markdown !== "string" || !Array.isArray(parsed.lines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function randomHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
