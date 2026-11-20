import { undoHint } from "./undo";
import type { Change, Receipt, RecordedAction } from "./types";

export type StoryTone = "created" | "changed" | "removed" | "read" | "unknown";

export interface StoryLine {
  service: string;
  source: "proxy" | "verified";
  write: boolean;
  tone: StoryTone;
  summary: string;
  seed: string;
  undo?: string;
  diff?: string;
  id?: string;
}

export function storyFromReceipt(receipt: Receipt): StoryLine[] {
  const lines: StoryLine[] = [];
  for (const action of receipt.actions ?? []) lines.push(actionLine(receipt.id, action));
  for (const change of receipt.changes) lines.push(changeLine(receipt.id, change));
  return assignIds(lines);
}

export function assignIds(lines: StoryLine[]): StoryLine[] {
  const used = new Set<string>();
  return lines.map((line) => {
    if (!line.write) return line;
    const id = shortId(line.seed, used);
    return { ...line, id };
  });
}

export function renderStory(input: { title: string; lines: StoryLine[]; link: string; linkLabel: string; imageUrl?: string }): string {
  const counts = countStory(input.lines);
  const parts = [`# ${input.title}`, "", countLine(counts)];
  if (input.imageUrl) parts.push("", `![${input.title}](${input.imageUrl})`);
  const groups = groupLines(input.lines);
  for (const group of groups) {
    parts.push("", `## ${group.service}`, "", group.source === "verified" ? "Verified from service history." : "Reported by proxy.");
    for (const line of group.lines) {
      const id = line.id ? ` \`${line.id}\`` : "";
      const undo = line.undo ? ` ${line.undo}` : "";
      parts.push(`${markerFor(line.tone)}${id} ${line.summary}${undo}`);
      if (line.diff) parts.push("", line.diff);
    }
  }
  parts.push("", `${input.linkLabel}: ${input.link}`);
  return parts.join("\n");
}

export function countStory(lines: StoryLine[]): { added: number; removed: number; modified: number; reads: number } {
  const counts = { added: 0, removed: 0, modified: 0, reads: 0 };
  for (const line of lines) {
    if (line.tone === "created") counts.added += 1;
    else if (line.tone === "removed") counts.removed += 1;
    else if (line.tone === "changed") counts.modified += 1;
    else counts.reads += 1;
  }
  return counts;
}

export function countLine(counts: { added: number; removed: number; modified: number; reads: number }): string {
  const base = `${counts.added} added, ${counts.removed} removed, ${counts.modified} modified`;
  return counts.reads > 0 ? `${base}, ${counts.reads} read` : base;
}

export function markerFor(tone: StoryTone): string {
  switch (tone) {
    case "created":
      return "🟢";
    case "changed":
      return "🟡";
    case "removed":
      return "🔴";
    case "read":
    case "unknown":
      return "⚪";
    default:
      return "⚪";
  }
}

export function cardRows(lines: StoryLine[]): { color: string; text: string }[] {
  return groupLines(lines).flatMap((group) => group.lines.slice(0, 8).map((line) => ({
    color: colorFor(line.tone),
    text: `${line.id ? line.id + " " : ""}${line.summary}`.slice(0, 72),
  }))).slice(0, 12);
}

function actionLine(receiptId: string, action: RecordedAction): StoryLine {
  const write = action.effect === "write" || action.tone === "created" || action.tone === "changed" || action.tone === "removed";
  const undo = undoHint(action);
  return {
    service: action.upstream || "unknown",
    source: "proxy",
    write,
    tone: action.tone,
    summary: action.summary,
    seed: `${receiptId}:${action.id}`,
    ...(undo ? { undo } : {}),
  };
}

function changeLine(receiptId: string, change: Change): StoryLine {
  const tone: StoryTone = change.kind === "added" ? "created" : change.kind === "removed" ? "removed" : "changed";
  const diff = diffBlock(change);
  return {
    service: "GitHub",
    source: "verified",
    write: true,
    tone,
    summary: change.summary,
    seed: `${receiptId}:${change.id}`,
    undo: change.link ? `Undo: cannot auto-undo. ${change.link}` : "Undo: cannot auto-undo.",
    ...(diff ? { diff } : {}),
  };
}

function diffBlock(change: Change): string | undefined {
  const rows: string[] = [];
  for (const field of change.fields.slice(0, 4)) {
    const before = cleanDiff(field.before);
    const after = cleanDiff(field.after);
    if (!before && after) rows.push(`+ ${field.label}: ${after}`);
    else if (before && !after) rows.push(`- ${field.label}: ${before}`);
    else if (before !== after) {
      rows.push(`- ${field.label}: ${before}`);
      rows.push(`+ ${field.label}: ${after}`);
    }
  }
  if (rows.length === 0) return undefined;
  return ["```diff", ...rows, "```"].join("\n");
}

function cleanDiff(value: string): string {
  return value.replace(/[`\n]/g, " ").trim().slice(0, 80);
}

function groupLines(lines: StoryLine[]): { service: string; source: StoryLine["source"]; lines: StoryLine[] }[] {
  const groups = new Map<string, { service: string; source: StoryLine["source"]; lines: StoryLine[] }>();
  for (const line of lines) {
    const key = `${line.source}\0${line.service}`;
    const group = groups.get(key) ?? { service: line.service, source: line.source, lines: [] };
    group.lines.push(line);
    groups.set(key, group);
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.lines.sort((a, b) => Number(b.write) - Number(a.write));
  }
  list.sort((a, b) => {
    const aw = a.lines.some((line) => line.write) ? 0 : 1;
    const bw = b.lines.some((line) => line.write) ? 0 : 1;
    return aw - bw || a.service.localeCompare(b.service);
  });
  return list;
}

function shortId(seed: string, used: Set<string>): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let n = hash >>> 0;
  for (let extra = 0; extra < 8; extra += 1) {
    const id = (n % 1296).toString(36).padStart(2, "0");
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    n = (Math.imul(n, 16777619) + extra + 1) >>> 0;
  }
  const fallback = `x${used.size.toString(36)}`;
  used.add(fallback);
  return fallback;
}

function colorFor(tone: StoryTone): string {
  switch (tone) {
    case "created":
      return "#0f5c32";
    case "changed":
      return "#6b4300";
    case "removed":
      return "#8d1c1c";
    default:
      return "#5c564c";
  }
}
