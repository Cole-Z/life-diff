import { undoHint } from "./undo";
import { assertNever } from "../text";
import type { Change, Receipt, RecordedAction } from "./types";

export type StoryTone = "created" | "changed" | "removed" | "read" | "failed" | "unknown";

export interface StoryDetail {
  text: string;
  before?: string;
  after?: string;
}

export interface StoryLine {
  service: string;
  source: "proxy" | "verified";
  write: boolean;
  tone: StoryTone;
  summary: string;
  seed: string;
  time?: string;
  undo?: string;
  id?: string;
  details?: StoryDetail[];
  link?: string;
  callKey?: string;
  ok?: boolean;
  readCount?: number;
}

const MAX_CHAT_LINES = 10;

export function storyFromReceipt(receipt: Receipt): StoryLine[] {
  return [
    ...storyFromActions(receipt.actions ?? []),
    ...storyFromChanges(receipt.id, receipt.changes),
  ];
}

export function storyFromActions(actions: RecordedAction[]): StoryLine[] {
  return actions.map(actionLine);
}

export function storyFromChanges(receiptId: string, changes: Change[]): StoryLine[] {
  return groupGitHub(receiptId, changes);
}

export function condenseLines(lines: StoryLine[], input: { detail: boolean }): StoryLine[] {
  const collapsed = collapseRetries(lines);
  const reads = new Map<string, StoryLine[]>();
  const rest: StoryLine[] = [];
  for (const line of collapsed) {
    if (!input.detail && line.tone === "read") {
      const group = reads.get(line.service) ?? [];
      group.push(line);
      reads.set(line.service, group);
      continue;
    }
    rest.push(line);
  }
  const folded: StoryLine[] = [...rest];
  for (const [service, items] of reads) {
    const label = serviceLabel(service);
    const noun = items.length === 1 ? "read" : "reads";
    folded.push({
      service,
      source: "proxy",
      write: false,
      tone: "read",
      summary: `${items.length} ${noun} across ${label}`,
      seed: `reads:${service}:${items.map((item) => item.seed).join(",")}`,
      readCount: items.length,
      details: items.map((item) => ({ text: item.summary })),
    });
  }
  return assignIds(orderLines(folded));
}

export function renderStory(input: {
  headline: string;
  lines: StoryLine[];
  link: string;
  linkLabel: string;
  imageUrl?: string;
  maxLines?: number;
}): string {
  const max = input.maxLines ?? MAX_CHAT_LINES;
  const shown = input.lines.slice(0, max);
  const parts = [input.headline, ""];
  let lastService = "";
  for (const line of shown) {
    if (line.service !== lastService) {
      if (lastService) parts.push("");
      parts.push(serviceLabel(line.service));
      lastService = line.service;
    }
    const undo = line.undo ? ` · ${line.undo}${line.id ? ` \`${line.id}\`` : ""}` : "";
    parts.push(`${markerFor(line.tone)} ${line.summary}${undo}`);
  }
  parts.push("", `${input.linkLabel}: ${input.link}`);
  if (input.imageUrl) parts.push("", `Card: ${input.imageUrl}`);
  return parts.join("\n");
}

export function headlineFor(lines: StoryLine[], label: string): string {
  const counts = countStory(lines);
  const parts: string[] = [];
  if (counts.added) parts.push(`${counts.added} created`);
  if (counts.modified) parts.push(`${counts.modified} changed`);
  if (counts.removed) parts.push(`${counts.removed} deleted`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.reads) parts.push(`${counts.reads} ${counts.reads === 1 ? "read" : "reads"}`);
  return `${label}: ${parts.length > 0 ? parts.join(" · ") : "nothing changed"}`;
}

export function countStory(lines: StoryLine[]): { added: number; removed: number; modified: number; reads: number; failed: number } {
  const counts = { added: 0, removed: 0, modified: 0, reads: 0, failed: 0 };
  for (const line of lines) {
    switch (line.tone) {
      case "created":
        counts.added += 1;
        break;
      case "changed":
        counts.modified += 1;
        break;
      case "removed":
        counts.removed += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "read":
        counts.reads += line.readCount ?? 1;
        break;
      case "unknown":
        break;
      default:
        assertNever(line.tone, "story tone");
    }
  }
  return counts;
}

export function markerFor(tone: StoryTone): string {
  switch (tone) {
    case "created":
      return "🟢";
    case "changed":
      return "🟡";
    case "removed":
      return "🔴";
    case "failed":
      return "⚠️";
    case "read":
    case "unknown":
      return "⚪";
    default:
      return assertNever(tone, "story tone");
  }
}

export function cardRows(lines: StoryLine[]): { color: string; text: string }[] {
  return lines.slice(0, 12).map((line) => ({
    color: colorFor(line.tone),
    text: line.summary.slice(0, 90),
  }));
}

export function assignIds(lines: StoryLine[]): StoryLine[] {
  const used = new Set<string>();
  return lines.map((line) => {
    if (!line.undo) return { ...line, id: undefined };
    return { ...line, id: shortId(line.seed, used) };
  });
}

function actionLine(action: RecordedAction): StoryLine {
  const failed = action.ok === false;
  const write = !failed && (action.effect === "write" || action.tone === "created" || action.tone === "changed" || action.tone === "removed");
  const tone: StoryTone = failed ? "failed" : action.tone;
  const undo = failed ? undefined : undoHint(action);
  return {
    service: action.upstream || "unknown",
    source: "proxy",
    write,
    tone,
    summary: action.summary,
    seed: action.id,
    time: action.time,
    callKey: `${action.upstream}\0${action.tool}\0${stable(action.arguments)}`,
    ok: action.ok,
    ...(undo ? { undo } : {}),
  };
}

function groupGitHub(receiptId: string, changes: Change[]): StoryLine[] {
  const byRepo = new Map<string, Change[]>();
  for (const change of changes) {
    if (absenceRemoval(change)) continue;
    const list = byRepo.get(change.repo) ?? [];
    list.push(change);
    byRepo.set(change.repo, list);
  }
  const lines: StoryLine[] = [];
  for (const [repo, items] of byRepo) {
    const files = items.filter((item) => item.resourceType === "file");
    const commits = items.filter((item) => item.resourceType === "commit");
    const branches = items.filter((item) => item.resourceType === "branch");
    const pulls = items.filter((item) => item.resourceType === "pull_request");
    const comments = items.filter((item) => item.resourceType === "comment");
    const merged = pulls.filter(isMerged);
    const consumed = new Set<string>();
    const stat = sumFiles(files);
    if (merged.length === 1 && merged[0]) {
      consume(consumed, merged[0]);
      for (const file of files) consume(consumed, file);
      for (const commit of commits) consume(consumed, commit);
      for (const branch of branches) {
        if (branch.kind === "modified") consume(consumed, branch);
      }
      lines.push(changeLine(receiptId, merged[0], mergedSummary(merged[0], stat), fileDetails(merged[0], files)));
    } else if (files.length > 1) {
      for (const file of files) consume(consumed, file);
      for (const commit of commits) consume(consumed, commit);
      lines.push({
        service: "GitHub",
        source: "verified",
        write: true,
        tone: fileTone(files),
        summary: `Changed ${stat.count} files on ${repo} · ${statText(stat)}`,
        seed: `${receiptId}:files:${repo}`,
        details: files.map(fileDetail),
        link: files.find((file) => file.link)?.link,
      });
    }
    for (const pull of merged) {
      if (consumed.has(pull.id)) continue;
      consume(consumed, pull);
      lines.push(changeLine(receiptId, pull, mergedSummary(pull, null), fieldDetails(pull)));
    }
    const loose = items.filter((item) => !consumed.has(item.id) && item.resourceType !== "comment");
    for (const item of loose) lines.push(changeLine(receiptId, item, item.summary, fieldDetails(item)));
    if (comments.length === 1 && comments[0]) lines.push(changeLine(receiptId, comments[0], comments[0].summary, fieldDetails(comments[0])));
    else if (comments.length > 1) {
      lines.push({
        service: "GitHub",
        source: "verified",
        write: true,
        tone: "created",
        summary: `${comments.length} comments on ${repo}`,
        seed: `${receiptId}:comments:${repo}`,
        details: comments.map((comment) => ({ text: comment.summary })),
        link: comments.find((comment) => comment.link)?.link,
      });
    }
  }
  return lines;
}

function changeLine(receiptId: string, change: Change, summary: string, details: StoryDetail[]): StoryLine {
  return {
    service: "GitHub",
    source: "verified",
    write: true,
    tone: toneForChange(change),
    summary,
    seed: `${receiptId}:${change.id}`,
    time: change.occurredAt,
    ...(details.length > 0 ? { details } : {}),
    ...(change.link ? { link: change.link } : {}),
  };
}

function mergedSummary(change: Change, stat: { count: number; add: number; del: number } | null): string {
  const title = change.resourceName.replaceAll('"', "'");
  const files = stat && stat.count > 0 ? ` · ${stat.count} ${stat.count === 1 ? "file" : "files"} · ${statText(stat)}` : "";
  return `Merged PR #${numberOf(change)} "${title}"${files}`;
}

function toneForChange(change: Change): StoryTone {
  if (isMerged(change)) return "created";
  const status = change.fields.find((field) => field.field === "status");
  if (status?.after === "closed" || change.summary.startsWith("Closed ")) return "removed";
  if (change.kind === "added") return "created";
  if (change.kind === "removed") return "removed";
  return "changed";
}

function isMerged(change: Change): boolean {
  const status = change.fields.find((field) => field.field === "status");
  return status?.after === "merged" || change.summary.startsWith("Merged pull request");
}

function absenceRemoval(change: Change): boolean {
  if (change.kind !== "removed") return false;
  if (change.resourceType === "file") return false;
  const status = change.fields.find((field) => field.field === "status");
  if (status?.after === "closed" || status?.after === "merged") return false;
  return true;
}

function fileTone(files: Change[]): StoryTone {
  if (files.every((file) => file.kind === "added")) return "created";
  if (files.every((file) => file.kind === "removed")) return "removed";
  return "changed";
}

function sumFiles(files: Change[]): { count: number; add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const file of files) {
    const stat = fileStat(file);
    add += stat.add;
    del += stat.del;
  }
  return { count: files.length, add, del };
}

function fileStat(change: Change): { add: number; del: number } {
  const content = change.fields.find((field) => field.field === "content")?.after ?? "";
  const match = /\+(\d[\d,]*)\s+[−-](\d[\d,]*)/.exec(content);
  if (!match?.[1] || !match[2]) return { add: 0, del: 0 };
  return { add: Number(match[1].replaceAll(",", "")), del: Number(match[2].replaceAll(",", "")) };
}

function statText(stat: { add: number; del: number }): string {
  return `+${stat.add.toLocaleString("en-US")} −${stat.del.toLocaleString("en-US")}`;
}

function fileDetails(pull: Change, files: Change[]): StoryDetail[] {
  return [...fieldDetails(pull), ...files.map(fileDetail)];
}

function fileDetail(change: Change): StoryDetail {
  const stat = fileStat(change);
  return { text: `${change.resourceName}  ${statText(stat)}` };
}

function fieldDetails(change: Change): StoryDetail[] {
  return change.fields.slice(0, 6).map((field) => ({
    text: field.label,
    ...(field.before ? { before: field.before } : {}),
    ...(field.after ? { after: field.after } : {}),
  }));
}

function numberOf(change: Change): string {
  const match = /#(\d+)/.exec(change.summary) ?? /:(\d+)$/.exec(change.resourceId);
  return match?.[1] ?? change.resourceName;
}

function consume(ids: Set<string>, change: Change): void {
  ids.add(change.id);
}

function collapseRetries(lines: StoryLine[]): StoryLine[] {
  const groups = new Map<string, StoryLine[]>();
  for (const line of lines) {
    if (!line.callKey) continue;
    const group = groups.get(line.callKey) ?? [];
    group.push(line);
    groups.set(line.callKey, group);
  }
  const drop = new Set<StoryLine>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    const pending: StoryLine[] = [];
    let succeeded = false;
    for (const line of ordered) {
      const failed = line.tone === "failed" || line.ok === false;
      if (!failed) {
        succeeded = true;
        for (const prior of pending) drop.add(prior);
        pending.length = 0;
      } else if (!succeeded) pending.push(line);
    }
    if (!succeeded && pending.length > 1) {
      for (const prior of pending.slice(0, -1)) drop.add(prior);
    }
  }
  return lines.filter((line) => !drop.has(line));
}

function orderLines(lines: StoryLine[]): StoryLine[] {
  const groups = new Map<string, StoryLine[]>();
  for (const line of lines) {
    const group = groups.get(line.service) ?? [];
    group.push(line);
    groups.set(line.service, group);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const aw = a[1].some((line) => line.tone !== "read") ? 0 : 1;
    const bw = b[1].some((line) => line.tone !== "read") ? 0 : 1;
    return aw - bw || a[0].localeCompare(b[0]);
  });
  const out: StoryLine[] = [];
  for (const [, group] of ordered) {
    group.sort((a, b) => toneRank(a.tone) - toneRank(b.tone) || (a.time ?? "").localeCompare(b.time ?? ""));
    out.push(...group);
  }
  return out;
}

function toneRank(tone: StoryTone): number {
  switch (tone) {
    case "created":
      return 0;
    case "changed":
      return 1;
    case "removed":
      return 2;
    case "failed":
      return 3;
    case "unknown":
      return 4;
    case "read":
      return 5;
    default:
      return assertNever(tone, "story tone");
  }
}

export function serviceLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Service";
  return trimmed.split(/[_-]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function stable(value: unknown): string {
  try {
    return JSON.stringify(sortValue(value));
  } catch {
    return "";
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key]);
    return out;
  }
  return value;
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
    case "failed":
      return "#8a4b08";
    case "read":
    case "unknown":
      return "#5c564c";
    default:
      return assertNever(tone, "story tone");
  }
}
