import { displayName } from "./names";
import type { Change, RecordedAction } from "./types";

/** Drive and Gmail keep trash for 30 days. Shown only when the clock is known. */
export const TRASH_WINDOW_DAYS = 30;

export interface UndoPlan {
  prompt: string;
  /** Original tool name, when this change came from a call. */
  tool?: string;
  /** Original arguments, when they were stored. */
  arguments?: Record<string, unknown>;
  /** A reversed call the agent can try. Life Diff does not run it. */
  suggestedTool?: string;
  suggestedArguments?: Record<string, unknown>;
  /** Whole days left in a known undo window, such as trash. */
  daysLeft?: number;
}

export interface UndoSource {
  tool?: string;
  upstream?: string;
  service?: string;
  verb?: string;
  tone?: string;
  summary: string;
  before?: string;
  after?: string;
  arguments?: unknown;
  time?: string;
  now?: string;
  resourceName?: string;
  kind?: string;
  resourceType?: string;
}

/**
 * A plain-English instruction the agent can run. Life Diff does not perform the undo.
 * Returns undefined for lookups, failures, and claims that matched nothing.
 */
export function undoPlan(input: UndoSource): UndoPlan | undefined {
  if (input.tone === "read" || input.tone === "failed" || input.tone === "not_found" || input.tone === "note" || input.tone === "unknown") {
    return undefined;
  }
  if (input.verb === "undo" || input.tool === "undo_request") return undefined;
  const service = displayName(input.service || input.upstream || "the service");
  const name = objectName(input);
  const args = recordOf(input.arguments);
  const before = input.before;
  const after = input.after;
  const verb = input.verb ?? "";
  const tool = input.tool ?? "";
  const blob = `${verb} ${tool} ${input.summary}`.toLowerCase();
  const prompt = instruction({ service, name, before, after, verb, tool, blob, summary: input.summary, kind: input.kind, resourceType: input.resourceType });
  const suggested = suggestCall(tool, verb, args, before, after);
  const daysLeft = trashDaysLeft(blob, input.time, input.now);
  return {
    prompt,
    ...(tool ? { tool } : {}),
    ...(args ? { arguments: args } : {}),
    ...(suggested.tool ? { suggestedTool: suggested.tool } : {}),
    ...(suggested.arguments ? { suggestedArguments: suggested.arguments } : {}),
    ...(daysLeft ? { daysLeft } : {}),
  };
}

export function undoForChange(change: Change, now?: string): UndoPlan | undefined {
  const status = change.fields.find((field) => field.field === "status");
  const before = change.fields.find((field) => field.before && field.after)?.before;
  const after = change.fields.find((field) => field.before && field.after)?.after;
  return undoPlan({
    service: "GitHub",
    summary: change.summary,
    resourceName: change.resourceName,
    kind: change.kind,
    resourceType: change.resourceType,
    tone: change.kind === "removed" ? "removed" : change.kind === "added" ? "created" : "changed",
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(status?.after ? { verb: status.after === "closed" || change.summary.startsWith("Closed ") ? "close" : status.after === "merged" ? "merge" : undefined } : {}),
    ...(change.occurredAt ? { time: change.occurredAt } : {}),
    ...(now ? { now } : {}),
  });
}

export function undoLabel(daysLeft?: number): string {
  if (!daysLeft || daysLeft < 1) return "Undo";
  return `Undo (${daysLeft} ${daysLeft === 1 ? "day" : "days"} left)`;
}

function instruction(input: {
  service: string;
  name: string;
  before?: string;
  after?: string;
  verb: string;
  tool: string;
  blob: string;
  summary: string;
  kind?: string;
  resourceType?: string;
}): string {
  const { service, name } = input;
  if (/\b(send|sent)\b/.test(input.blob)) {
    return `A message already sent from ${service} cannot be unsent. Ask before sending a correction.`;
  }
  if (input.resourceType === "commit" && input.kind === "added") return `Revert the commit on ${name}.`;
  if (input.verb === "close" || input.summary.startsWith("Closed ")) return `Reopen ${name} on ${service}.`;
  if (input.verb === "merge" || input.summary.startsWith("Merged ")) return `The merge of ${name} cannot be undone from here. Open ${service} if you need to revert it.`;
  if (input.before && (input.verb === "move" || input.verb === "rename" || looksLikeWhen(input.before))) {
    if (input.verb === "rename" || /\brenam/.test(input.blob)) {
      return `Rename ${quoted(input.after || name)} back to ${quoted(input.before)} in ${service}.`;
    }
    return `Move ${quoted(name)} back to ${input.before} on ${service}.`;
  }
  if (/\b(trash|trashed)\b/.test(input.blob)) {
    const what = /^[\d,]+\s+files?$/.test(name) ? `the ${name}` : quoted(name);
    return `Restore ${what} from ${service} trash.`;
  }
  if (input.verb === "share" || /\bshare/.test(input.blob)) {
    const who = input.after && !looksLikeWhen(input.after) ? input.after : "the new person";
    return `Stop sharing ${quoted(name)} with ${who} in ${service}.`;
  }
  if (input.verb === "create" || input.verb === "add" || input.kind === "added" || input.summary.toLowerCase().includes("added") || input.summary.startsWith("Created ") || input.summary.startsWith("Opened ")) {
    return `Delete ${quoted(name)} from ${service}.`;
  }
  if (input.verb === "delete" || input.verb === "remove" || input.kind === "removed" || input.summary.startsWith("Deleted ")) {
    return `Restore ${quoted(name)} in ${service}.`;
  }
  if (input.before && input.after) return `Change ${quoted(name)} back to ${input.before} in ${service}.`;
  return `Undo this change in ${service}: ${input.summary.replace(/\.$/, "")}.`;
}

function suggestCall(
  tool: string,
  verb: string,
  args: Record<string, unknown> | undefined,
  before?: string,
  after?: string,
): { tool?: string; arguments?: Record<string, unknown> } {
  if (!tool) return {};
  const base = args ? { ...args } : {};
  if (verb === "create" || /\b(create|add|insert)\b/.test(tool)) {
    return { tool: swapToken(swapToken(swapToken(tool, "create", "delete"), "add", "remove"), "insert", "delete"), arguments: base };
  }
  if (verb === "trash" || /\btrash\b/.test(tool)) {
    return { tool: swapToken(tool, "trash", "restore"), arguments: base };
  }
  if (verb === "share" || /\bshare\b/.test(tool)) {
    return { tool: swapToken(tool, "share", "unshare"), arguments: base };
  }
  if (/\bclose\b/.test(tool)) return { tool: swapToken(tool, "close", "reopen"), arguments: base };
  if ((verb === "move" || verb === "update" || verb === "rename") && (before || after)) {
    const next = { ...base };
    if (before) {
      next.after = before;
      if (after) next.before = after;
    }
    return { tool, arguments: next };
  }
  return { tool, ...(args ? { arguments: base } : {}) };
}

/** Swap a verb inside snake_case tool names: trash_file becomes restore_file. */
function swapToken(tool: string, from: string, to: string): string {
  return tool.replace(new RegExp(`(?<![a-z])${from}(?![a-z])`, "i"), to);
}

function trashDaysLeft(blob: string, time?: string, now?: string): number | undefined {
  if (!/\b(trash|trashed)\b/.test(blob) || !time) return undefined;
  const start = Date.parse(time);
  const clock = Date.parse(now || time);
  if (!Number.isFinite(start) || !Number.isFinite(clock)) return undefined;
  const elapsed = Math.floor((clock - start) / 86_400_000);
  const left = TRASH_WINDOW_DAYS - Math.max(0, elapsed);
  return left > 0 ? left : undefined;
}

function objectName(input: UndoSource): string {
  const args = recordOf(input.arguments);
  const fromArgs = args ? text(args.title) || text(args.name) || text(args.subject) || text(args.summary) : undefined;
  if (fromArgs) return fromArgs;
  if (input.resourceName) return input.resourceName;
  const quotedName = /['"“”‘’]([^'"“”‘’]{1,80})['"“”‘’]/.exec(input.summary)?.[1]?.trim();
  if (quotedName) return quotedName;
  if (!input.summary || input.summary === input.tool || input.summary.includes("_")) {
    return friendlyObject(input.tool, input.service || input.upstream);
  }
  const cleaned = input.summary.replace(/\.$/, "").trim();
  return cleaned || "this";
}

function friendlyObject(tool: string | undefined, service: string | undefined): string {
  const blob = `${tool ?? ""} ${service ?? ""}`.toLowerCase();
  if (blob.includes("event") || blob.includes("calendar")) return "this event";
  if (blob.includes("file") || blob.includes("drive")) return "this file";
  if (blob.includes("page")) return "this page";
  if (blob.includes("message") || blob.includes("mail")) return "this message";
  return "this";
}

function quoted(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
  if (trimmed.startsWith("this ") || trimmed.startsWith("the ") || /^[\d,]+\s+files?$/.test(trimmed)) return trimmed;
  return `"${trimmed.replaceAll('"', "'")}"`;
}

function looksLikeWhen(value: string): boolean {
  return /\b(mon|tue|wed|thu|fri|sat|sun|am|pm)\b/i.test(value) || /\d:\d\d/.test(value);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function planFromAction(action: {
  tool: string;
  upstream: string;
  verb?: string;
  tone?: string;
  effect?: string;
  summary: string;
  arguments?: unknown;
  time?: string;
  ok?: boolean;
}, now?: string): UndoPlan | undefined {
  if (action.effect === "read" || action.tone === "read" || action.ok === false) return undefined;
  const span = spanOf(action.arguments);
  return undoPlan({
    tool: action.tool,
    upstream: action.upstream,
    service: action.upstream,
    ...(action.verb ? { verb: action.verb } : {}),
    tone: action.tone,
    summary: action.summary,
    ...(span.before ? { before: span.before } : {}),
    ...(span.after ? { after: span.after } : {}),
    ...(action.arguments !== undefined ? { arguments: action.arguments } : {}),
    ...(action.time ? { time: action.time } : {}),
    ...(now ? { now } : {}),
  });
}

function spanOf(value: unknown): { before?: string; after?: string } {
  const record = recordOf(value);
  if (!record) return {};
  const before = text(record.before);
  const after = text(record.after);
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/** @deprecated Kept so older call sites compile. Prefer undoPlan. */
export function reversalHint(action: Pick<RecordedAction, "tool" | "upstream" | "verb" | "tone" | "effect">): string | undefined {
  const plan = undoPlan({
    tool: action.tool,
    upstream: action.upstream,
    ...(action.verb ? { verb: action.verb } : {}),
    tone: action.tone,
    summary: action.tool,
  });
  if (!plan) return undefined;
  if (/\bcannot be unsent\b/.test(plan.prompt) || /\bcannot be undone\b/.test(plan.prompt)) return undefined;
  return plan.prompt;
}

export function reversalForChange(change: Pick<Change, "resourceType" | "kind" | "summary" | "fields">): string | undefined {
  const plan = undoForChange(change as Change);
  return plan?.prompt;
}
