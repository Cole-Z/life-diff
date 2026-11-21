import { redactText } from "../proxy/redact";
import { assertNever } from "../text";
import { dedupeStoredReads } from "./corroborate";
import { serviceForClaim } from "./claims";
import { displayName } from "./names";
import { lineRepo } from "./phrase";
import { claimSentence, presentAction } from "./present";
import { reversalForChange } from "./undo";
import type { Change, ClaimResult, Receipt, RecordedAction } from "./types";

export type StoryTone = "created" | "changed" | "removed" | "read" | "failed" | "unknown" | "note";

export interface StoryDetail {
  text: string;
  before?: string;
  after?: string;
}

export type LineSource = "proxy" | "claim" | "verified";

export function trustLabel(source: LineSource, service: string): string {
  const name = displayName(service);
  switch (source) {
    case "proxy":
      return `Sent to ${name}, not verified`;
    case "claim":
      return "Agent says it did this, not verified";
    case "verified":
      return `Verified in ${name}`;
    default: {
      const never: never = source;
      return never;
    }
  }
}

export interface StoryLine {
  service: string;
  source: LineSource;
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
  verb?: string;
  tool?: string;
  readCount?: number;
  repo?: string;
  client?: string;
  trust?: string;
  hint?: string;
}

const MAX_CHAT_LINES = 10;

export function visibleActions(receipt: Pick<Receipt, "actions" | "claims">): RecordedAction[] {
  const actions = dedupeStoredReads(receipt.actions ?? []);
  const verified = new Set(receipt.claims.filter((claim) => claim.status === "verified").map((claim) => claim.id));
  return actions.filter((action) => !(action.source === "claim" && verified.has(action.id)));
}

export function storyFromReceipt(receipt: Receipt): StoryLine[] {
  const actions = visibleActions(receipt);
  return [
    ...storyFromActions(actions),
    ...storyFromChanges(receipt.id, receipt.changes),
    ...storyFromUnverifiedClaims(receipt.claims, new Set(actions.map((action) => action.id))),
    ...mismatchLines(actions, receipt.changes),
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
      const key = `${line.source}\0${line.service}`;
      const group = reads.get(key) ?? [];
      group.push(line);
      reads.set(key, group);
      continue;
    }
    rest.push(line);
  }
  const folded: StoryLine[] = [...rest];
  for (const items of reads.values()) {
    const first = items[0];
    if (!first) continue;
    const noun = items.length === 1 ? "lookup" : "lookups";
    const clients = new Set(items.map((item) => item.client).filter((client): client is string => Boolean(client)));
    folded.push({
      service: first.service,
      source: first.source,
      write: false,
      tone: "read",
      summary: `${items.length} ${noun}`,
      seed: `reads:${first.source}:${first.service}:${items.map((item) => item.seed).join(",")}`,
      readCount: items.length,
      trust: trustLabel(first.source, first.service),
      details: items.map((item) => ({ text: item.summary })),
      ...(clients.size === 1 ? { client: [...clients][0] } : {}),
    });
  }
  return assignIds(orderLines(folded)).map(stampTrust);
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
  const notes = input.lines.filter((line) => line.tone === "note");
  const bodyAll = input.lines.filter((line) => line.tone !== "note");
  const visible = Number.isFinite(max) ? bodyAll.slice(0, max) : bodyAll;
  const body = coalesceRepos(visible);
  const hidden = bodyAll.length - visible.length;
  const showReadTrust = lookupSourcesMixed(bodyAll);
  const clients = new Set(body.map((line) => line.client).filter((client): client is string => Boolean(client)));
  const showClient = clients.size > 1;
  const parts = [input.headline, ""];
  const services = new Map<string, StoryLine[]>();
  for (const line of body) {
    const list = services.get(line.service) ?? [];
    list.push(line);
    services.set(line.service, list);
  }
  let index = 0;
  for (const [service, lines] of services) {
    if (index > 0) parts.push("");
    index += 1;
    parts.push(`**${serviceLabel(service)}**`);
    for (const group of repoGroups(lines)) {
      if (group.heading === "Other") parts.push("Other");
      else if (group.heading) parts.push(repoHeading(group.heading, group.lines, showClient));
      for (const line of group.lines) parts.push(formatLine(line, showClient && !line.repo, showReadTrust));
    }
  }
  if (hidden > 0) parts.push(`+${hidden} more`);
  for (const note of notes) {
    parts.push("", note.summary.endsWith(".") ? note.summary : `${note.summary}.`);
  }
  parts.push("", `${input.linkLabel}: ${input.link}`);
  return redactText(parts.join("\n"));
}

/** Session receipts and the daily page use the same wording. `label` is the card caption, not this line. */
export function headlineFor(lines: StoryLine[], _label: string): string {
  let changed = 0;
  let reported = 0;
  let failed = 0;
  let reads = 0;
  for (const line of lines) {
    if (line.tone === "note" || line.tone === "unknown") continue;
    if (line.tone === "read") {
      reads += line.readCount ?? 1;
      continue;
    }
    if (line.tone === "failed") {
      failed += 1;
      continue;
    }
    if (line.source === "claim") {
      reported += 1;
      continue;
    }
    if (line.tone === "created" || line.tone === "changed" || line.tone === "removed") changed += 1;
  }
  if (changed === 0 && failed === 0 && reported === 0) {
    if (reads === 0) return "Nothing changed";
    const noun = reads === 1 ? "lookup" : "lookups";
    return `Nothing changed · ${reads} ${noun}`;
  }
  if (changed === 0 && reported === 0) return failed === 1 ? "1 failed call" : `${failed} failed calls`;
  const total = changed + reported;
  let headline: string;
  if (reported === 0) headline = total === 1 ? "1 change" : `${total} changes`;
  else if (changed === 0) headline = total === 1 ? "1 change needs a look" : `${total} changes need a look`;
  else {
    const changes = total === 1 ? "1 change" : `${total} changes`;
    const lookText = reported === 1 ? "1 needs a look" : `${reported} need a look`;
    headline = `${changes}, ${lookText}`;
  }
  if (failed === 0) return headline;
  const failedText = failed === 1 ? "1 failed" : `${failed} failed`;
  return `${headline} · ${failedText}`;
}

/** Nothing was changed, claimed, or failed. The chat text is the headline alone, unless detail is on or lookup sources are mixed. */
export function isQuiet(lines: StoryLine[]): boolean {
  return lines.every((line) => line.tone === "read" || line.tone === "note" || line.tone === "unknown");
}

export function chatText(input: {
  headline: string;
  lines: StoryLine[];
  link: string;
  linkLabel: string;
  detail?: boolean;
}): { markdown: string; quiet: boolean } {
  const quiet = isQuiet(input.lines);
  const mixed = lookupSourcesMixed(input.lines);
  if (quiet && input.detail !== true && !mixed) return { markdown: input.headline, quiet: true };
  return {
    markdown: renderStory({
      ...input,
      ...(input.detail === true ? { maxLines: Number.POSITIVE_INFINITY } : {}),
    }),
    quiet,
  };
}

/** Lookup rows name their source only when the day mixes more than one. */
export function lookupSourcesMixed(lines: StoryLine[]): boolean {
  const sources = new Set<LineSource>();
  for (const line of lines) {
    if (line.tone === "read") sources.add(line.source);
  }
  return sources.size > 1;
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
      case "note":
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
    case "note":
      return "";
    default:
      return assertNever(tone, "story tone");
  }
}

export function cardRows(lines: StoryLine[]): { color: string; text: string; source: LineSource }[] {
  const visible = lines.filter((line) => line.tone !== "note");
  const showReadTrust = lookupSourcesMixed(visible);
  return visible.map((line) => ({
    color: lineColor(line),
    text: cardLineText(line, showReadTrust),
    source: line.source,
  }));
}

export function cardLineText(line: StoryLine, showReadTrust = false): string {
  const service = serviceLabel(line.service);
  const summary = line.summary.replace(/\.$/, "");
  const named = summary.toLowerCase().includes(service.toLowerCase()) ? summary : `${service}: ${summary}`;
  if (line.tone === "failed") return redactText(named);
  if (line.tone === "read") {
    const trust = showReadTrust && line.trust ? ` · ${line.trust}` : "";
    return redactText(`${named}${trust}`);
  }
  const trust = line.trust ?? trustLabel(line.source, line.service);
  return redactText(`${named} · ${trust}`);
}

export function lineColor(line: StoryLine): string {
  return colorFor(displayTone(line));
}

export function displayTone(line: StoryLine): StoryTone {
  if (line.tone === "failed" || line.tone === "read" || line.tone === "note" || line.tone === "unknown") return line.tone;
  if (isDestructiveLine(line)) return "removed";
  if (line.source === "claim" && line.write) return "changed";
  return line.tone;
}

export function lineMarker(line: StoryLine): string {
  return markerFor(displayTone(line));
}

export function assignIds(lines: StoryLine[]): StoryLine[] {
  const used = new Set<string>();
  return lines.map((line) => {
    if (!line.undo) return { ...line, id: undefined };
    return { ...line, id: shortId(line.seed, used) };
  });
}

function actionLine(action: RecordedAction): StoryLine {
  const presented = presentAction(action);
  const source = action.source === "claim" ? "claim" : "proxy";
  const service = displayName(action.upstream || action.tool || "Service");
  const details = presented.before || presented.after
    ? [{ text: "When", ...(presented.before ? { before: presented.before } : {}), ...(presented.after ? { after: presented.after } : {}) }]
    : undefined;
  return {
    service,
    source,
    write: presented.write,
    tone: presented.tone,
    summary: presented.summary,
    seed: action.id,
    time: action.time,
    callKey: `${action.upstream}\0${action.tool}\0${stable(action.arguments)}`,
    ok: action.ok,
    trust: presented.tone === "failed" ? failedTrust(service) : trustLabel(source, service),
    ...(action.verb ? { verb: action.verb } : {}),
    ...(action.tool ? { tool: action.tool } : {}),
    ...(presented.repo ? { repo: presented.repo } : {}),
    ...(presented.link ? { link: presented.link } : {}),
    ...(details ? { details } : {}),
    ...(presented.hint ? { hint: presented.hint } : {}),
    ...(presented.undoable ? { undo: "Undo available" } : {}),
    ...(presented.client ? { client: presented.client } : {}),
  };
}

export function storyFromUnverifiedClaims(claims: ClaimResult[], shownIds: Set<string>): StoryLine[] {
  return claims.filter((claim) => claim.status === "missing" && claim.action !== "read" && !shownIds.has(claim.id)).map((claim) => {
    const service = serviceForClaim(claim);
    const tone = claim.action === "added" ? "created" : claim.action === "removed" ? "removed" : "changed";
    const repo = lineRepo({ ...(claim.repo ? { repo: claim.repo } : {}), target: claim.target, summary: claim.detail });
    return {
      service,
      source: "claim" as const,
      write: true,
      tone,
      summary: claimSentence({
        tool: toolOf(claim),
        target: claim.target,
        tone,
        ...(claim.detail ? { detail: claim.detail } : {}),
        ...(claim.before ? { before: claim.before } : {}),
        ...(claim.after ? { after: claim.after } : {}),
      }),
      seed: claim.id,
      trust: trustLabel("claim", service),
      hint: "Undo not available yet",
      ...(claim.url?.startsWith("https://") ? { link: claim.url } : {}),
      ...(repo ? { repo } : {}),
    };
  });
}

/** Named repositories in first-seen order. Lines with no repo of their own go in Other at the end, and only when some line in the set has a repo. */
export function repoGroups(lines: StoryLine[]): { heading: string; lines: StoryLine[] }[] {
  const named = new Map<string, StoryLine[]>();
  const other: StoryLine[] = [];
  for (const line of lines) {
    const repo = line.repo?.trim() ?? "";
    if (!repo) {
      other.push(line);
      continue;
    }
    const group = named.get(repo) ?? [];
    group.push(line);
    named.set(repo, group);
  }
  const groups = [...named.entries()].map(([heading, groupLines]) => ({ heading, lines: groupLines }));
  if (other.length === 0) return groups;
  if (groups.length === 0) return [{ heading: "", lines: other }];
  return [...groups, { heading: "Other", lines: other }];
}

function toolOf(claim: ClaimResult): string {
  const match = /(?:^|\.\s*)Tool ([^.]+)/.exec(claim.detail ?? "");
  return match?.[1]?.trim() || claim.service || "claim";
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
        repo,
        trust: trustLabel("verified", "GitHub"),
        details: files.map(fileDetail),
        link: files.find((file) => file.link)?.link,
        hint: "Undo not available yet",
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
        repo,
        trust: trustLabel("verified", "GitHub"),
        details: comments.map((comment) => ({ text: comment.summary })),
        link: comments.find((comment) => comment.link)?.link,
        hint: "Undo not available yet",
      });
    }
  }
  return lines;
}

function changeLine(receiptId: string, change: Change, summary: string, details: StoryDetail[]): StoryLine {
  const undoable = Boolean(reversalForChange(change));
  return {
    service: "GitHub",
    source: "verified",
    write: true,
    tone: toneForChange(change),
    summary,
    seed: `${receiptId}:${change.id}`,
    time: change.occurredAt,
    repo: change.repo,
    trust: trustLabel("verified", "GitHub"),
    hint: undoable ? "Undo available" : "Undo not available yet",
    ...(details.length > 0 ? { details } : {}),
    ...(change.link ? { link: change.link } : {}),
    ...(undoable ? { undo: "Undo available" } : {}),
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
  return [...lines].sort((a, b) => attentionRank(a) - attentionRank(b) || a.service.localeCompare(b.service) || (a.time ?? "").localeCompare(b.time ?? ""));
}

function attentionRank(line: StoryLine): number {
  if (line.tone === "note") return 5;
  if (line.tone === "read" || line.tone === "unknown") return 4;
  if (line.source === "claim" && line.tone !== "failed") return 0;
  if (line.tone === "failed") return 1;
  if (isDestructiveLine(line)) return 2;
  if (line.tone === "created" || line.tone === "changed" || line.tone === "removed") return 3;
  return 4;
}

function isDestructiveLine(line: StoryLine): boolean {
  if (line.tone === "failed" || line.tone === "read" || line.tone === "note" || line.tone === "unknown") return false;
  if (line.tone === "removed") return true;
  const blob = `${line.verb ?? ""} ${line.tool ?? ""} ${line.summary}`.toLowerCase().replace(/[_-]+/g, " ");
  return /\b(deleted|delete|removed|remove|sent|send|shared|share|sharing|permissions|permission|unshared|unshare|revoked|revoke|trashed|trash)\b/.test(blob);
}

export function serviceLabel(name: string): string {
  return displayName(name);
}

function formatLine(line: StoryLine, showClient: boolean, showReadTrust: boolean): string {
  const mark = lineMarker(line);
  const prefix = mark ? `${mark} ` : "";
  const link = line.link ? ` · [Open](${line.link})` : "";
  const trust = line.tone === "failed"
    ? ""
    : line.tone === "read"
      ? (showReadTrust && line.trust ? ` · ${line.trust}` : "")
      : (line.trust ? ` · ${line.trust}` : "");
  const hint = line.hint ? ` · ${line.hint}` : "";
  const by = showClient && line.client ? ` · ${line.client}` : "";
  return `${prefix}${line.summary}${link}${trust}${hint}${by}`;
}

/** Keep one heading per repository inside a service, in the order that repository first appeared. */
function coalesceRepos(lines: StoryLine[]): StoryLine[] {
  const out: StoryLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const service = lines[index]?.service ?? "";
    let end = index + 1;
    while (end < lines.length && lines[end]?.service === service) end += 1;
    const order: string[] = [];
    const groups = new Map<string, StoryLine[]>();
    for (const line of lines.slice(index, end)) {
      const key = line.repo ?? "";
      const list = groups.get(key);
      if (list) list.push(line);
      else {
        order.push(key);
        groups.set(key, [line]);
      }
    }
    for (const key of order) {
      const grouped = groups.get(key);
      if (grouped) out.push(...grouped);
    }
    index = end;
  }
  return out;
}

function stampTrust(line: StoryLine): StoryLine {
  if (line.tone !== "failed") return line;
  const trust = failedTrust(line.service);
  if (line.trust === trust) return line;
  return { ...line, trust };
}

function failedTrust(service: string): string {
  return `Failed in ${displayName(service)}`;
}

function repoHeading(repo: string, lines: StoryLine[], showClient: boolean): string {
  const clients = new Set(lines.map((line) => line.client).filter((client): client is string => Boolean(client)));
  const client = clients.size === 1 ? [...clients][0] : undefined;
  const writes = lines.filter((line) => line.write && line.tone !== "failed" && line.tone !== "read");
  if (showClient && client && writes.length === 1) {
    const summary = writes[0]?.summary ?? "";
    const kind = summary.includes("pull request") ? "pull request opened" : summary.includes("issue") ? "issue" : "change";
    return `${repo}: 1 ${kind} by ${client}`;
  }
  if (showClient && client) return `${repo} · ${client}`;
  return repo;
}

function mismatchLines(actions: RecordedAction[], changes: Change[]): StoryLine[] {
  const lines: StoryLine[] = [];
  for (const action of actions) {
    if (action.ok === false) continue;
    const number = closedNumber(action);
    if (!number) continue;
    const related = changes.filter((change) => numberOf(change) === number && (change.resourceType === "issue" || change.resourceType === "pull_request"));
    const stillOpen = related.some((change) => statusAfter(change) === "open");
    const closed = related.some((change) => {
      const status = statusAfter(change);
      return status === "closed" || status === "merged" || change.summary.startsWith("Closed ") || change.summary.startsWith("Merged ");
    });
    if (!stillOpen || closed) continue;
    const repo = related[0]?.repo;
    const source = action.source === "claim" ? "claim" : "proxy";
    lines.push({
      service: "GitHub",
      source,
      write: true,
      tone: "failed",
      summary: `Agent said it closed #${number}, but GitHub shows it still open.`,
      seed: `mismatch:${action.id}`,
      time: action.time,
      trust: failedTrust("GitHub"),
      ...(repo ? { repo } : {}),
    });
  }
  return lines;
}

function closedNumber(action: RecordedAction): string | undefined {
  if (!action.tool.toLowerCase().includes("close")) return undefined;
  const record = action.arguments && typeof action.arguments === "object" && !Array.isArray(action.arguments)
    ? action.arguments as Record<string, unknown>
    : undefined;
  for (const key of ["number", "issue_number", "issueNumber"]) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isInteger(value)) return String(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return value;
  }
  return /#(\d+)/.exec(action.summary)?.[1];
}

function statusAfter(change: Change): string | undefined {
  return change.fields.find((field) => field.field === "status")?.after;
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
      return "#F5A524";
    case "removed":
      return "#8d1c1c";
    case "failed":
      return "#8d1c1c";
    case "read":
    case "unknown":
    case "note":
      return "#5c564c";
    default:
      return assertNever(tone, "story tone");
  }
}
