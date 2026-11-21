import { classifyToolName, type Classification } from "../proxy/classify";
import { lineRepo, phraseAction, safeLink } from "./phrase";
import type { ActionTone, RecordedAction } from "./types";

export interface PresentedAction {
  tone: "created" | "changed" | "removed" | "moved" | "shared" | "read" | "failed";
  effect: "read" | "write";
  summary: string;
  write: boolean;
  repo?: string;
  link?: string;
  before?: string;
  after?: string;
  client?: string;
}

export interface ClaimSentenceInput {
  tool: string;
  target: string;
  tone?: ActionTone;
  verb?: string;
  detail?: string;
  before?: string;
  after?: string;
}

/**
 * Classify again from the tool name. Calls stored before the classifier knew
 * a verb, and unknown non-writes, become lookups instead of their own line.
 */
export function presentAction(action: RecordedAction): PresentedAction {
  const classification = reclassify(action);
  const failed = action.ok === false;
  const span = spanOf(action.arguments);
  const claim = action.source === "claim" && !failed && classification.effect === "write";
  const subject = quotedSubject(action.summary, action.tool);
  const summary = claim
    ? claimSentence({
      tool: action.tool,
      target: span.subject || action.summary || action.tool,
      tone: classification.tone,
      ...(action.verb ? { verb: action.verb } : {}),
      ...(span.detail ? { detail: span.detail } : {}),
      ...(span.before ? { before: span.before } : {}),
      ...(span.after ? { after: span.after } : {}),
    })
    : phraseAction({
      upstream: action.upstream,
      tool: action.tool,
      classification,
      args: action.arguments,
      ...(subject ? { subject } : {}),
      ok: !failed,
      ...(action.error ? { error: action.error } : {}),
    });
  const write = !failed && classification.effect === "write";
  const link = safeLink(action.arguments, action.result);
  const repo = lineRepo({ ...(action.repo ? { repo: action.repo } : {}), arguments: action.arguments, summary: action.summary });
  return {
    tone: failed ? "failed" : classification.tone === "unknown" ? "read" : presentedTone(classification),
    effect: classification.effect === "write" ? "write" : "read",
    summary,
    write,
    ...(repo ? { repo } : {}),
    ...(link ? { link } : {}),
    ...(span.before ? { before: span.before } : {}),
    ...(span.after ? { after: span.after } : {}),
    ...(action.client ? { client: action.client } : {}),
  };
}

/** Older stored calls kept move and share on the changed or removed tone. The verb still decides the row. */
function presentedTone(classification: Classification): PresentedAction["tone"] {
  if (classification.verb === "move" || classification.verb === "rename") return "moved";
  if (classification.verb === "share") return "shared";
  if (classification.verb === "trash") return "removed";
  if (classification.tone === "unknown") return "read";
  return classification.tone;
}

/** One plain line for a change the agent reported, using the target and any before/after. */
export function claimSentence(input: ClaimSentenceInput): string {
  const title = clean(input.target);
  const detail = publicDetail(input.detail);
  const verb = (input.verb ?? "").toLowerCase();
  const blob = `${verb} ${input.tool} ${title}`.toLowerCase();
  if (input.before && input.after && (verb === "move" || verb === "rename" || input.tone === "moved" || looksLikeWhen(input.before) || looksLikeWhen(input.after))) {
    if (verb === "rename" || /\brenam/.test(blob)) return `${title} renamed ${input.before} → ${input.after}`;
    return `${title} moved ${input.before} → ${input.after}`;
  }
  if (input.tone === "shared" || verb === "share" || /\bshare/.test(blob)) {
    return `${title} shared with ${input.after || "a new person"}`;
  }
  if (input.tone === "created" || /\b(add|added|create|created)\b/.test(blob)) {
    return input.after ? `${title} added, ${input.after}` : looksLikeSentence(title) ? title.replace(/\.$/, "") : `${title} added`;
  }
  if (verb === "trash" || /\btrash/.test(blob)) return `${title} moved to trash`;
  if (input.tone === "removed" || /\b(delete|deleted|remove|removed)\b/.test(blob)) {
    return looksLikeSentence(title) ? title.replace(/\.$/, "") : `${title} removed`;
  }
  if (input.before && input.after) return `${title} changed ${input.before} → ${input.after}`;
  if (looksLikeSentence(title)) {
    const base = title.replace(/\.$/, "");
    if (detail && !base.includes(detail)) return `${base}, ${detail}`;
    return base;
  }
  const base = `${claimVerb(input, title)} ${title}`;
  if (detail && !base.includes(detail)) return `${base}, ${detail}`;
  return base;
}

function claimVerb(input: ClaimSentenceInput, title: string): string {
  const blob = `${input.verb ?? ""} ${input.tool} ${title}`.toLowerCase();
  if (input.tone === "created" || /\b(add|added|create|created)\b/.test(blob)) return "Created";
  if (input.tone === "removed" || /\b(delete|deleted|remove|removed)\b/.test(blob)) return "Deleted";
  if (/\b(move|moved|reschedul)/.test(blob) || looksLikeWhen(input.before) || looksLikeWhen(input.after)) return "Moved";
  if (/\brenam/.test(blob)) return "Renamed";
  return "Changed";
}

function looksLikeSentence(value: string): boolean {
  return value.split(/\s+/).filter(Boolean).length >= 4;
}

function looksLikeWhen(value: string | undefined): boolean {
  if (!value) return false;
  return /\b(mon|tue|wed|thu|fri|sat|sun|am|pm)\b/i.test(value) || /\d:\d\d/.test(value);
}

function publicDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const stripped = detail.replace(/^Tool [^.]+\.?\s*/, "").trim();
  return stripped || undefined;
}

function clean(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/^['"]|['"]$/g, "");
}

function spanOf(value: unknown): { subject?: string; detail?: string; before?: string; after?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const subject = typeof record.subject === "string" ? record.subject : undefined;
  const detail = typeof record.detail === "string" ? record.detail : undefined;
  const before = typeof record.before === "string" ? record.before : undefined;
  const after = typeof record.after === "string" ? record.after : undefined;
  return {
    ...(subject ? { subject } : {}),
    ...(detail ? { detail } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
}

function reclassify(action: RecordedAction): Classification {
  const fresh = classifyToolName(action.tool);
  const specific = specificStored(action);
  // A logged move, share, or trash wins over a generic update in the tool name.
  if (specific && (fresh.effect !== "write" || fresh.tone === "changed")) return specific;
  if (fresh.effect === "write" || fresh.effect === "read") return fresh;
  if (isStoredWrite(action.effect, action.tone)) {
    return {
      effect: "write",
      tone: action.tone === "created" || action.tone === "changed" || action.tone === "removed" || action.tone === "moved" || action.tone === "shared" ? action.tone : "changed",
      ...(action.verb ? { verb: action.verb } : {}),
    };
  }
  return { effect: "read", tone: "read" };
}

function specificStored(action: RecordedAction): Classification | undefined {
  if (action.verb === "rename") return { effect: "write", tone: "moved", verb: "rename" };
  if (action.verb === "move" || action.tone === "moved") return { effect: "write", tone: "moved", verb: "move" };
  if (action.verb === "share" || action.tone === "shared") return { effect: "write", tone: "shared", verb: "share" };
  if (action.verb === "trash") return { effect: "write", tone: "removed", verb: "trash" };
  return undefined;
}

function isStoredWrite(effect: RecordedAction["effect"], tone: ActionTone): boolean {
  return effect === "write" && (tone === "created" || tone === "changed" || tone === "removed" || tone === "moved" || tone === "shared");
}

/** Pull a quoted subject out of an old stored sentence when the arguments no longer have it. */
export function quotedSubject(summary: string, tool: string): string | undefined {
  const match = /['"“”‘’]([^'"“”‘’]{1,80})['"“”‘’]/.exec(summary);
  const found = match?.[1]?.trim();
  if (!found || found === tool || found.includes("__")) return undefined;
  return found;
}
