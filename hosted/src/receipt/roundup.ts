import type { CoreDeps } from "../app/service";
import { recordedFrom } from "./actions";
import { bytesToBase64, receiptCardKey, renderCardPng } from "./card";
import { assignIds, renderStory, storyFromReceipt, type StoryLine } from "./story";
import type { Receipt } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 40;

export interface Roundup {
  since: string;
  at: string;
  markdown: string;
  lines: StoryLine[];
  png: Uint8Array;
  imageUrl?: string;
  cardToken?: string;
}

export function roundupJsonKey(userId: string): string {
  return `users/${userId}/roundup.json`;
}

export function roundupCardKey(token: string): string {
  return `roundups/${token}.png`;
}

interface StoredRoundup {
  at: string;
  since: string;
  markdown: string;
  lines: StoryLine[];
  cardToken: string;
  cardKey: string;
  imageUrl: string;
}

export async function buildRoundup(deps: CoreDeps & { issuer: string }, input: { since?: string; save: boolean }): Promise<Roundup> {
  const stored = await loadStored(deps);
  const since = resolveSince(input.since, stored, deps.now);
  const lines = await collectLines(deps, since);
  const token = input.save ? randomHex() : stored?.cardToken;
  const origin = deps.issuer.replace(/\/$/, "");
  const imageUrl = token ? `${origin}/roundup/card.png?t=${token}` : undefined;
  const page = `${origin}/roundup`;
  const markdown = renderStory({
    title: "Life Diff roundup",
    lines,
    link: page,
    linkLabel: "Open the roundup",
    ...(imageUrl ? { imageUrl } : {}),
  });
  const png = await renderCardPng(lines, "Life Diff roundup");
  if (input.save && token) {
    if (stored?.cardKey && stored.cardKey !== roundupCardKey(token)) await deps.objects.delete([stored.cardKey]);
    const cardKey = roundupCardKey(token);
    await deps.objects.putBytes(cardKey, png, "image/png");
    const body: StoredRoundup = { at: deps.now.toISOString(), since, markdown, lines, cardToken: token, cardKey, imageUrl: imageUrl ?? "" };
    await deps.objects.put(roundupJsonKey(deps.userId), JSON.stringify(body), "application/json");
  }
  return { since, at: deps.now.toISOString(), markdown, lines, png, ...(imageUrl ? { imageUrl } : {}), ...(token ? { cardToken: token } : {}) };
}

export async function loadRoundup(deps: CoreDeps & { issuer: string }): Promise<Roundup | null> {
  const stored = await loadStored(deps);
  if (!stored) return null;
  const png = await deps.objects.getBytes(stored.cardKey);
  return {
    since: stored.since,
    at: stored.at,
    markdown: stored.markdown,
    lines: stored.lines,
    png: png ?? new Uint8Array(),
    imageUrl: stored.imageUrl,
    cardToken: stored.cardToken,
  };
}

export async function receiptPresentation(deps: CoreDeps, receipt: Receipt, link: string): Promise<{ markdown: string; png: Uint8Array; imageUrl?: string }> {
  const lines = storyFromReceipt(receipt);
  const imageUrl = receipt.cardToken ? `${link}/card.png?t=${receipt.cardToken}` : undefined;
  const markdown = renderStory({
    title: "Life Diff receipt",
    lines,
    link,
    linkLabel: "Open the receipt",
    ...(imageUrl ? { imageUrl } : {}),
  });
  const stored = await deps.objects.getBytes(receiptCardKey(`receipts/${deps.userId}/${receipt.id}.json`));
  const png = stored ?? await renderCardPng(lines, "Life Diff");
  return { markdown, png, ...(imageUrl ? { imageUrl } : {}) };
}

export function pngContent(png: Uint8Array): { type: "image"; data: string; mimeType: "image/png" } | null {
  if (png.length < 8) return null;
  return { type: "image", data: bytesToBase64(png), mimeType: "image/png" };
}

async function collectLines(deps: CoreDeps, since: string): Promise<StoryLine[]> {
  const receipts = await deps.meta.listReceiptsSince(deps.userId, since, MAX_RECEIPTS);
  const lines: StoryLine[] = [];
  for (const meta of receipts) {
    const json = await deps.objects.get(meta.jsonKey);
    if (!json) continue;
    let receipt: Receipt;
    try {
      receipt = JSON.parse(json) as Receipt;
    } catch {
      continue;
    }
    lines.push(...storyFromReceipt(receipt));
  }
  const open = await deps.sessions.getOpen();
  if (open) {
    const logged = await deps.sessions.list(open.id);
    for (const action of logged) {
      if (action.loggedAt < since) continue;
      const recorded = recordedFrom(action);
      if (!recorded) continue;
      lines.push(...storyFromReceipt({ ...emptyReceipt(open.id), actions: [recorded] }).map((line) => ({ ...line, id: undefined })));
    }
  }
  return assignIds(lines);
}

function emptyReceipt(id: string): Receipt {
  return {
    schemaVersion: "1.0.0",
    id,
    generatedAt: "",
    readOnly: true,
    producer: { name: "", version: "" },
    snapshot: { id: "", takenAt: "" },
    comparedAt: "",
    timeZone: "UTC",
    session: { startedAt: "", checkedAt: "" },
    github: { repos: [], diffMode: "snapshot", truncatedSnapshot: false, truncatedChanges: false, suppressedRemovals: false },
    counts: { added: 0, removed: 0, modified: 0, verifiedClaims: 0, missingClaims: 0, unclaimedChanges: 0 },
    changes: [],
    claimsChecked: false,
    claims: [],
    notes: [],
  };
}

function resolveSince(requested: string | undefined, stored: StoredRoundup | null, now: Date): string {
  if (requested?.trim()) {
    const parsed = Date.parse(requested);
    if (Number.isNaN(parsed)) throw new Error("since must be an ISO time.");
    return new Date(parsed).toISOString();
  }
  if (stored?.at && !Number.isNaN(Date.parse(stored.at))) return stored.at;
  return new Date(now.getTime() - DAY_MS).toISOString();
}

async function loadStored(deps: CoreDeps): Promise<StoredRoundup | null> {
  const raw = await deps.objects.get(roundupJsonKey(deps.userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredRoundup;
    if (!parsed || typeof parsed.at !== "string" || !Array.isArray(parsed.lines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function randomHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
