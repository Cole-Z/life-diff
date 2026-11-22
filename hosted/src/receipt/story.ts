import { redactText } from "../proxy/redact";
import { assertNever, formatRange } from "../text";
import { dedupeStoredReads } from "./corroborate";
import { isGitHubClaimService, serviceForClaim } from "./claims";
import { displayName, shortService } from "./names";
import { lineRepo } from "./phrase";
import { claimSentence, presentAction } from "./present";
import { coveredClaimIds, undoDedupeKey } from "./merge";
import { planFromAction, undoForChange, undoLabel, type UndoPlan } from "./undo";
import type { Change, ClaimResult, Receipt, RecordedAction } from "./types";

export type StoryTone = "created" | "changed" | "removed" | "moved" | "shared" | "read" | "failed" | "unknown" | "note" | "not_found" | "not_checked";

export interface StoryDetail {
  text: string;
  before?: string;
  after?: string;
}

export type LineSource = "proxy" | "claim" | "verified";

/** Short tag for a row. The longer definitions stay in the receipt notes. */
export function trustLabel(source: LineSource, _service: string): string {
  switch (source) {
    case "proxy":
    case "claim":
      return "Agent said";
    case "verified":
      return "Verified";
    default: {
      const never: never = source;
      return never;
    }
  }
}

/** Lookups Life Diff forwarded name the service. A lookup only the agent reported stays Agent said. */
export function lookupTrust(source: LineSource, service: string): string {
  if (source === "proxy") return `Sent to ${displayName(service)}`;
  return trustLabel(source, service);
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
  undoTool?: string;
  undoArguments?: Record<string, unknown>;
  undoSuggestedTool?: string;
  undoSuggestedArguments?: Record<string, unknown>;
  undoDaysLeft?: number;
  /** Set when a verified change matched something the agent claimed. */
  claimed?: boolean;
  receiptId?: string;
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
  lookupClients?: string[];
  trust?: string;
  hint?: string;
  /** Set after undo_change or undo_session. The prompt stays, the row no longer offers a fresh Undo link. */
  undoRequested?: boolean;
}

const MAX_CHAT_LINES = 10;

export function visibleActions(receipt: Pick<Receipt, "actions" | "claims">): RecordedAction[] {
  const actions = dedupeStoredReads(receipt.actions ?? []);
  const verified = new Set(receipt.claims.filter((claim) => claim.status === "verified").map((claim) => claim.id));
  return actions.filter((action) => !(action.source === "claim" && verified.has(action.id)));
}

export function storyFromReceipt(receipt: Receipt): StoryLine[] {
  const actions = visibleActions(receipt);
  const covered = coveredClaimIds(actions, receipt.claims);
  const requested = new Set(receipt.undoRequestedSeeds ?? []);
  const lines = [
    ...storyFromActions(actions),
    ...storyFromChanges(receipt.id, receipt.changes),
    ...storyFromUnverifiedClaims(receipt.claims, new Set([...actions.map((action) => action.id), ...covered])),
    ...mismatchLines(actions, receipt.changes),
  ].map((line) => ({
    ...line,
    receiptId: line.receiptId ?? receipt.id,
    ...(requested.has(line.seed) ? { undoRequested: true } : {}),
  }));
  return markUnmatched(lines, receipt.claims);
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
      trust: lookupTrust(first.source, first.service),
      details: items.map((item) => ({ text: item.summary })),
      ...(clients.size === 1 ? { client: [...clients][0] } : {}),
      ...(clients.size > 1 ? { lookupClients: [...clients] } : {}),
    });
  }
  return assignIds(dedupeUndo(orderLines(folded))).map(stampTrust);
}

export function renderStory(input: {
  headline: string;
  lines: StoryLine[];
  link: string;
  linkLabel: string;
  imageUrl?: string;
  maxLines?: number;
  eyebrow?: string;
  title?: string;
  footer?: string;
  timeZone?: string;
  startedAt?: string;
  endedAt?: string;
  detail?: boolean;
}): string {
  const max = input.maxLines ?? MAX_CHAT_LINES;
  const notes = input.lines.filter((line) => line.tone === "note");
  const showReads = input.detail === true;
  const bodyAll = input.lines.filter((line) => line.tone !== "note" && (showReads || line.tone !== "read"));
  const visible = Number.isFinite(max) ? bodyAll.slice(0, max) : bodyAll;
  const body = coalesceRepos(visible);
  const hidden = bodyAll.length - visible.length;
  const clients = new Set(clientNames(input.lines));
  const showClient = clients.size > 1;
  const eyebrow = input.eyebrow ?? (input.link.includes("/roundup") || /day/i.test(input.linkLabel) ? "TODAY" : "SESSION DIFF");
  const title = input.title ?? agentTitle(input.lines, input.timeZone, input.startedAt, input.endedAt);
  const chips = summaryText(input.lines);
  const parts = [eyebrow, title];
  if (chips) parts.push("", chips);
  parts.push("");
  let index = 0;
  for (const [service, lines] of linesByService(body)) {
    if (index > 0) parts.push("");
    index += 1;
    parts.push(`**${service}**`);
    for (const group of repoGroups(lines)) {
      if (group.heading) parts.push(group.heading);
      for (const line of group.lines) {
        parts.push(...formatChange(line, input.link, showClient));
        parts.push("");
      }
    }
  }
  if (hidden > 0) parts.push(`+${hidden} more`, "");
  const footer = input.footer ?? footerFor(input.lines);
  if (footer) parts.push(footer);
  for (const note of notes) {
    parts.push("", note.summary.endsWith(".") ? note.summary : `${note.summary}.`);
  }
  parts.push("", `${input.linkLabel}: ${input.link}`);
  return redactText(parts.join("\n").replace(/\n{3,}/g, "\n\n"));
}

/** Quiet sessions stay one line. Anything else is the colored count line, such as `+1 added  ~1 changed`. */
export function headlineFor(lines: StoryLine[], _label: string): string {
  if (isQuiet(lines)) {
    let reads = 0;
    for (const line of lines) {
      if (line.tone === "read") reads += line.readCount ?? 1;
    }
    if (reads === 0) return "Nothing changed";
    return `Nothing changed · ${reads === 1 ? "1 lookup" : `${reads} lookups`}`;
  }
  const chips = summaryText(lines);
  const failed = lines.filter((line) => line.tone === "failed").length;
  const failedText = failed === 0 ? "" : failed === 1 ? "1 failed" : `${failed} failed`;
  const headline = [chips, failedText].filter(Boolean).join(" · ");
  if (headline) return headline;
  const footer = footerFor(lines);
  return footer || "Nothing changed";
}

export function clientNames(lines: StoryLine[]): string[] {
  return [...new Set(lines.flatMap((line) => line.lookupClients ?? (line.client ? [line.client] : [])))];
}

export function agentTitle(lines: StoryLine[], timeZone?: string, startedAt?: string, endedAt?: string, agentName?: string): string {
  const names = clientNames(lines);
  const named = agentName?.trim();
  const who = names.length === 0 ? (named || "Agent") : names.join(", ");
  const times = lines.map((line) => line.time).filter((time): time is string => Boolean(time)).sort();
  const start = startedAt || times[0];
  const end = endedAt || times[times.length - 1];
  if (start && end && timeZone) {
    const range = formatRange(start, end, timeZone);
    if (range) return `${who} · ${range}`;
  }
  return who;
}

/** Nothing was changed, claimed, or failed. The chat text is the headline alone, unless detail is on or lookup sources are mixed. */
export function isQuiet(lines: StoryLine[]): boolean {
  return lines.every((line) => line.tone === "read" || line.tone === "unknown" || (line.tone === "note" && !/^Undo requested\b/.test(line.summary)));
}

export function chatText(input: {
  headline: string;
  lines: StoryLine[];
  link: string;
  linkLabel: string;
  detail?: boolean;
  eyebrow?: string;
  title?: string;
  timeZone?: string;
  startedAt?: string;
  endedAt?: string;
}): { markdown: string; quiet: boolean } {
  const quiet = isQuiet(input.lines);
  if (quiet && input.detail !== true) return { markdown: input.headline, quiet: true };
  return {
    markdown: renderStory({
      ...input,
      ...(input.detail === true ? { maxLines: Number.POSITIVE_INFINITY, detail: true } : {}),
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

export function countStory(lines: StoryLine[]): { added: number; removed: number; modified: number; moved: number; shared: number; reads: number; failed: number } {
  const counts = { added: 0, removed: 0, modified: 0, moved: 0, shared: 0, reads: 0, failed: 0 };
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
      case "moved":
        counts.moved += 1;
        break;
      case "shared":
        counts.shared += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "read":
        counts.reads += line.readCount ?? 1;
        break;
      case "unknown":
      case "note":
      case "not_found":
      case "not_checked":
        break;
      default:
        assertNever(line.tone, "story tone");
    }
  }
  return counts;
}

const CHIP_ORDER = ["added", "changed", "removed", "moved", "shared"] as const;
type ChipKind = (typeof CHIP_ORDER)[number];

const CHIP_SYMBOL: Record<ChipKind, string> = {
  added: "+",
  changed: "~",
  removed: "−",
  moved: "→",
  shared: "↗",
};

const CHIP_LABEL: Record<ChipKind, string> = {
  added: "added",
  changed: "changed",
  removed: "removed",
  moved: "moved",
  shared: "shared",
};

export interface SummaryChip {
  kind: ChipKind;
  count: number;
  symbol: string;
  label: string;
}

/** Nonzero kind counts, in the order the card shows them. */
export function summaryChips(lines: StoryLine[]): SummaryChip[] {
  const counts: Record<ChipKind, number> = { added: 0, changed: 0, removed: 0, moved: 0, shared: 0 };
  for (const line of lines) {
    const kind = chipKind(line);
    if (kind) counts[kind] += 1;
  }
  return CHIP_ORDER.filter((kind) => counts[kind] > 0).map((kind) => ({
    kind,
    count: counts[kind],
    symbol: CHIP_SYMBOL[kind],
    label: CHIP_LABEL[kind],
  }));
}

export function summaryText(lines: StoryLine[]): string {
  return summaryChips(lines).map((chip) => `${chip.symbol}${chip.count} ${chip.label}`).join("  ");
}

export interface StorySummary {
  added: number;
  changed: number;
  removed: number;
  moved: number;
  shared: number;
  verified: number;
  agentSaid: number;
  notFound: number;
  notChecked: number;
  failed: number;
  /** Same chip line the markdown prints. Empty when every kind count is zero. */
  text: string;
}

/** Counts the markdown is built from. Trust words match the row tags, never "missing". */
export function storySummary(lines: StoryLine[]): StorySummary {
  const counts: Record<ChipKind, number> = { added: 0, changed: 0, removed: 0, moved: 0, shared: 0 };
  let verified = 0;
  let agentSaid = 0;
  let notFound = 0;
  let notChecked = 0;
  let failed = 0;
  for (const line of lines) {
    const tone = displayTone(line);
    const kind = chipKind(line);
    if (kind) counts[kind] += 1;
    if (tone === "read" || tone === "note" || tone === "unknown") continue;
    if (tone === "failed") {
      failed += 1;
      continue;
    }
    if (tone === "not_found") {
      notFound += 1;
      continue;
    }
    if (tone === "not_checked") {
      notChecked += 1;
      continue;
    }
    const trust = line.trust ?? trustLabel(line.source, line.service);
    if (trust === "Verified" || line.source === "verified") verified += 1;
    else agentSaid += 1;
  }
  return {
    added: counts.added,
    changed: counts.changed,
    removed: counts.removed,
    moved: counts.moved,
    shared: counts.shared,
    verified,
    agentSaid,
    notFound,
    notChecked,
    failed,
    text: summaryText(lines),
  };
}

export function footerFor(lines: StoryLine[]): string {
  let claimed = 0;
  let found = 0;
  let notFound = 0;
  let notChecked = 0;
  let lookups = 0;
  for (const line of lines) {
    if (line.tone === "read") {
      lookups += line.readCount ?? 1;
      continue;
    }
    if (line.tone === "note" || line.tone === "unknown") continue;
    if (line.tone === "not_found") {
      notFound += 1;
      claimed += 1;
      continue;
    }
    if (line.tone === "not_checked") {
      notChecked += 1;
      claimed += 1;
      continue;
    }
    if (line.tone === "failed") continue;
    if (line.source === "verified") {
      found += 1;
      if (line.claimed) claimed += 1;
      continue;
    }
    if (line.source === "claim" && line.write) {
      claimed += 1;
      notChecked += 1;
    }
  }
  const parts: string[] = [];
  if (claimed > 0) {
    parts.push(`Agent claimed ${claimed} ${claimed === 1 ? "thing" : "things"}`);
    if (found > 0) parts.push(`${found} found in your accounts`);
    if (notFound > 0) parts.push(`${notFound} not found`);
    if (notChecked > 0) parts.push(`${notChecked} not checked`);
  } else if (found > 0) {
    parts.push(`${found} found in your accounts`);
  }
  if (lookups > 0) parts.push(`${lookups} ${lookups === 1 ? "lookup" : "lookups"}`);
  return parts.join(" · ");
}

function chipKind(line: StoryLine): ChipKind | null {
  const tone = displayTone(line);
  switch (tone) {
    case "created":
      return "added";
    case "changed":
      return "changed";
    case "removed":
      return "removed";
    case "moved":
      return "moved";
    case "shared":
      return "shared";
    case "failed":
    case "read":
    case "unknown":
    case "note":
    case "not_found":
    case "not_checked":
      return null;
    default:
      return assertNever(tone, "story tone");
  }
}

export function markerFor(tone: StoryTone): string {
  switch (tone) {
    case "created":
      return "+";
    case "changed":
      return "~";
    case "removed":
      return "−";
    case "moved":
      return "→";
    case "shared":
      return "↗";
    case "failed":
      return "Failed";
    case "not_found":
      return "?";
    case "not_checked":
      return "Not checked";
    case "read":
    case "unknown":
    case "note":
      return "";
    default:
      return assertNever(tone, "story tone");
  }
}

export function cardRows(lines: StoryLine[]): { color: string; text: string; source: LineSource }[] {
  const visible = lines.filter((line) => line.tone !== "note" && line.tone !== "read" && line.tone !== "unknown");
  return visible.map((line) => ({
    color: lineColor(line),
    text: cardLineText(line),
    source: line.source,
  }));
}

export function cardLineText(line: StoryLine, _showReadTrust = false): string {
  const summary = rowBody(line);
  if (line.tone === "read") return redactText(summary);
  const kind = displayTone(line);
  const symbol = markerFor(kind);
  const label = kindName(kind);
  const service = shortService(line.service);
  if (kind === "failed") return redactText(`Failed · ${service} — ${summary}`);
  if (kind === "not_found") return redactText(`? Not found · Agent said — ${summary}${undoState(line)}`);
  if (kind === "not_checked") return redactText(`Not checked · ${service} · Agent said — ${summary}${undoState(line)}`);
  const trust = line.trust ?? trustLabel(line.source, line.service);
  const mark = symbol ? `${symbol} ` : "";
  return redactText(`${mark}${label} · ${service} · ${trust} — ${summary}${undoState(line)}`);
}

function undoState(line: StoryLine): string {
  return line.undoRequested ? " · Undo requested" : "";
}

export function lineColor(line: StoryLine): string {
  return colorFor(displayTone(line));
}

export function displayTone(line: StoryLine): StoryTone {
  if (line.tone === "failed" || line.tone === "read" || line.tone === "note" || line.tone === "unknown" || line.tone === "not_found" || line.tone === "not_checked" || line.tone === "moved" || line.tone === "shared") {
    return line.tone;
  }
  if (isDestructiveLine(line)) return "removed";
  return line.tone;
}

export function lineMarker(line: StoryLine): string {
  return markerFor(displayTone(line));
}

export function assignIds(lines: StoryLine[]): StoryLine[] {
  const used = new Set<string>();
  return lines.map((line) => {
    if (!line.undo && !needsRowId(line)) return { ...line, id: undefined };
    return { ...line, id: shortId(line.seed, used) };
  });
}

/** Not found, not checked, and failed rows can be named so undo_change can refuse them. */
function needsRowId(line: StoryLine): boolean {
  return line.tone === "not_found" || line.tone === "not_checked" || line.tone === "failed";
}

function dedupeUndo(lines: StoryLine[]): StoryLine[] {
  const seen = new Set<string>();
  return lines.map((line) => {
    if (!line.undo || line.undoRequested) return line;
    const key = undoDedupeKey(line);
    if (seen.has(key)) {
      return {
        ...line,
        undo: undefined,
        undoTool: undefined,
        undoArguments: undefined,
        undoSuggestedTool: undefined,
        undoSuggestedArguments: undefined,
        undoDaysLeft: undefined,
        hint: "Undo not available",
      };
    }
    seen.add(key);
    return line;
  });
}

function actionLine(action: RecordedAction): StoryLine {
  if (action.verb === "undo" || action.tool === "undo_request") {
    const summary = /^Undo requested\b/.test(action.summary) ? action.summary : "Undo requested. Life Diff did not run it.";
    return {
      service: "Life Diff",
      source: action.source === "claim" ? "claim" : "proxy",
      write: false,
      tone: "note",
      summary: summary.endsWith(".") ? summary : `${summary}.`,
      seed: action.id,
      time: action.time,
    };
  }
  const presented = presentAction(action);
  const source = action.source === "claim" ? "claim" : "proxy";
  const service = displayName(action.upstream || action.tool || "Service");
  const details = presented.before || presented.after
    ? [{ text: "When", ...(presented.before ? { before: presented.before } : {}), ...(presented.after ? { after: presented.after } : {}) }]
    : undefined;
  const plan = presented.write
    ? planFromAction({ ...action, tone: presented.tone === "failed" ? action.tone : presented.tone, summary: presented.summary })
    : undefined;
  const shaped = plan ? { ...plan, prompt: plan.prompt.replace(action.upstream, service) } : undefined;
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
    trust: presented.tone === "failed" ? failedTrust(service) : presented.tone === "read" ? lookupTrust(source, service) : trustLabel(source, service),
    ...(action.verb ? { verb: action.verb } : {}),
    ...(action.tool ? { tool: action.tool } : {}),
    ...(presented.repo ? { repo: presented.repo } : {}),
    ...(presented.link ? { link: presented.link } : {}),
    ...(details ? { details } : {}),
    ...(presented.client ? { client: presented.client } : {}),
    ...(presented.write && (source === "proxy" || source === "claim") ? undoFields(shaped) : {}),
  };
}

export function storyFromUnverifiedClaims(claims: ClaimResult[], shownIds: Set<string>): StoryLine[] {
  return claims.filter((claim) => claim.status === "missing" && claim.action !== "read" && !shownIds.has(claim.id)).map((claim) => {
    const service = serviceForClaim(claim);
    const repo = lineRepo({ ...(claim.repo ? { repo: claim.repo } : {}), target: claim.target, summary: claim.detail });
    if (githubMiss(claim)) {
      return {
        service,
        source: "claim" as const,
        write: false,
        tone: "not_found" as const,
        summary: `"${claim.target}": no matching change`,
        seed: claim.id,
        trust: "Agent said",
        hint: "Undo not available",
        ...(claim.url?.startsWith("https://") ? { link: claim.url } : {}),
        ...(repo ? { repo } : {}),
      };
    }
    const tone = claim.action === "added" ? "created" : claim.action === "removed" ? "removed" : claim.action === "moved" ? "moved" : claim.action === "shared" ? "shared" : "changed";
    const summary = claimSentence({
      tool: toolOf(claim),
      target: claim.target,
      tone,
      ...(claim.detail ? { detail: claim.detail } : {}),
      ...(claim.before ? { before: claim.before } : {}),
      ...(claim.after ? { after: claim.after } : {}),
    });
    return {
      service,
      source: "claim" as const,
      write: false,
      tone: "not_checked" as const,
      summary,
      seed: claim.id,
      trust: "Agent said",
      hint: "Undo not available",
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

function linesByService(lines: StoryLine[]): Map<string, StoryLine[]> {
  const services = new Map<string, StoryLine[]>();
  for (const line of lines) {
    const list = services.get(line.service) ?? [];
    list.push(line);
    services.set(line.service, list);
  }
  return services;
}

function githubMiss(claim: ClaimResult): boolean {
  if (!/No matching change/.test(claim.reason)) return false;
  // A tool named in the detail wins. An old claim stored as GitHub may really be Calendar.
  if (serviceForClaim(claim) !== "GitHub") return false;
  return isGitHubClaimService(claim.service);
}

function markUnmatched(lines: StoryLine[], claims: ClaimResult[]): StoryLine[] {
  const misses = new Map(claims.filter(githubMiss).map((claim) => [claim.id, claim]));
  return lines.map((line) => {
    const claim = misses.get(line.seed);
    if (!claim || line.tone === "not_found") return line;
    return {
      ...line,
      tone: "not_found" as const,
      write: false,
      summary: `"${claim.target}": no matching change`,
      trust: "Agent said",
      undo: undefined,
      undoTool: undefined,
      undoArguments: undefined,
      undoSuggestedTool: undefined,
      undoSuggestedArguments: undefined,
      undoDaysLeft: undefined,
    };
  });
}

function undoFields(plan: UndoPlan | undefined): Pick<StoryLine, "undo" | "undoTool" | "undoArguments" | "undoSuggestedTool" | "undoSuggestedArguments" | "undoDaysLeft"> {
  if (!plan) return {};
  return {
    undo: plan.prompt,
    ...(plan.tool ? { undoTool: plan.tool } : {}),
    ...(plan.arguments ? { undoArguments: plan.arguments } : {}),
    ...(plan.suggestedTool ? { undoSuggestedTool: plan.suggestedTool } : {}),
    ...(plan.suggestedArguments ? { undoSuggestedArguments: plan.suggestedArguments } : {}),
    ...(plan.daysLeft ? { undoDaysLeft: plan.daysLeft } : {}),
  };
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
        undo: `Undo the file changes on ${repo}.`,
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
        undo: `Delete the comments on ${repo} if they should not stay.`,
      });
    }
  }
  return lines;
}

function changeLine(receiptId: string, change: Change, summary: string, details: StoryDetail[]): StoryLine {
  const plan = undoForChange({ ...change, summary });
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
    ...(change.claimStatus === "verified" ? { claimed: true } : {}),
    ...(details.length > 0 ? { details } : {}),
    ...(change.link ? { link: change.link } : {}),
    ...undoFields(plan ? { ...plan, prompt: plan.prompt } : undefined),
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
    const key = `${line.callKey}\0${line.client ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
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
  if (line.tone === "created" || line.tone === "changed" || line.tone === "removed" || line.tone === "moved" || line.tone === "shared") return 3;
  return 4;
}

function isDestructiveLine(line: StoryLine): boolean {
  if (line.tone === "failed" || line.tone === "read" || line.tone === "note" || line.tone === "unknown") return false;
  if (line.tone === "removed") return true;
  const blob = `${line.verb ?? ""} ${line.tool ?? ""} ${line.summary}`.toLowerCase().replace(/[_-]+/g, " ");
  return /\b(deleted|delete|removed|remove|sent|send|permissions|permission|unshared|unshare|revoked|revoke|trashed|trash)\b/.test(blob);
}

export function serviceLabel(name: string): string {
  return displayName(name);
}

function formatChange(line: StoryLine, pageLink: string, showClient: boolean): string[] {
  const kind = displayTone(line);
  const service = shortService(line.service);
  const trust = line.tone === "failed" || line.tone === "read" ? "" : (line.trust ?? trustLabel(line.source, line.service));
  const who = showClient && line.client ? ` · ${line.client}` : "";
  let head: string;
  if (kind === "failed") head = `Failed · ${service}${who}`;
  else if (kind === "not_found") head = `? Not found · Agent said${who}`;
  else if (kind === "not_checked") head = `Not checked · ${service} · Agent said${who}`;
  else if (kind === "read") head = `${service}${who}`;
  else head = `${markerFor(kind)} ${kindName(kind)} · ${service}${trust ? ` · ${trust}` : ""}${who}`;
  const href = line.undoRequested ? undefined : undoHref(pageLink, line);
  const link = line.link ? ` · [Open](${line.link})` : "";
  const undo = line.undoRequested
    ? " · Undo requested"
    : href
      ? ` · [${undoLabel(line.undoDaysLeft)}](${href})`
      : line.hint
        ? ` · ${line.hint}`
        : "";
  return [head, `${rowBody(line)}${link}${undo}`];
}

/** Keep one repository's lines together inside a service, in the order that repository first appeared. */
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

export function undoPlansFor(receipt: Receipt, origin: string): {
  changeId: string;
  prompt: string;
  summary: string;
  service: string;
  url: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  suggestedTool?: string;
  suggestedArguments?: Record<string, unknown>;
  daysLeft?: number;
}[] {
  const lines = condenseLines(storyFromReceipt(receipt), { detail: false });
  return lines.flatMap((line) => {
    if (!line.undo || !line.id) return [];
    return [{
      changeId: line.id,
      prompt: line.undo,
      summary: rowBody(line),
      service: line.service,
      url: `${origin.replace(/\/$/, "")}/receipts/${encodeURIComponent(receipt.id)}/undo/${encodeURIComponent(line.id)}`,
      ...(line.undoTool ? { tool: line.undoTool } : {}),
      ...(line.undoArguments ? { arguments: line.undoArguments } : {}),
      ...(line.undoSuggestedTool ? { suggestedTool: line.undoSuggestedTool } : {}),
      ...(line.undoSuggestedArguments ? { suggestedArguments: line.undoSuggestedArguments } : {}),
      ...(line.undoDaysLeft ? { daysLeft: line.undoDaysLeft } : {}),
      ...(line.undoRequested ? { requested: true as const } : {}),
    }];
  });
}

export function undoHref(pageLink: string, line: StoryLine): string | undefined {
  if (!line.undo || !line.id || line.undoRequested) return undefined;
  let origin = "";
  let path = "";
  try {
    const url = new URL(pageLink);
    origin = url.origin;
    path = url.pathname.replace(/\/$/, "");
  } catch {
    return undefined;
  }
  if (line.receiptId) return `${origin}/receipts/${encodeURIComponent(line.receiptId)}/undo/${encodeURIComponent(line.id)}`;
  if (path.includes("/receipts/")) return `${origin}${path}/undo/${encodeURIComponent(line.id)}`;
  return undefined;
}

export function kindName(tone: StoryTone): string {
  switch (tone) {
    case "created":
      return "Added";
    case "changed":
      return "Changed";
    case "removed":
      return "Removed";
    case "moved":
      return "Moved";
    case "shared":
      return "Shared";
    case "failed":
      return "Failed";
    case "not_found":
      return "Not found";
    case "not_checked":
      return "Not checked";
    case "read":
      return "Lookup";
    case "unknown":
    case "note":
      return "";
    default:
      return assertNever(tone, "story tone");
  }
}

export function rowBody(line: StoryLine): string {
  if (line.tone !== "failed") return line.summary.replace(/\.$/, "");
  const summary = line.summary.replace(/\.$/, "");
  const service = displayName(line.service);
  const prefix = `Failed in ${service}`;
  if (!summary.startsWith(prefix)) return line.summary;
  const rest = summary.slice(prefix.length).replace(/^[.\s]+/, "");
  return rest || line.summary;
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
    case "failed":
      return "#8d1c1c";
    case "moved":
    case "shared":
      return "#2f6fed";
    case "not_checked":
      return "#c4a15a";
    case "not_found":
    case "read":
    case "unknown":
    case "note":
      return "#8a8175";
    default:
      return assertNever(tone, "story tone");
  }
}
