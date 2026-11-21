import { classifyToolName, type Classification } from "../proxy/classify";
import { phraseAction, repoOf, safeLink } from "./phrase";
import { reversalHint } from "./undo";
import type { ActionTone, RecordedAction } from "./types";

export interface PresentedAction {
  tone: "created" | "changed" | "removed" | "read" | "failed";
  effect: "read" | "write";
  summary: string;
  write: boolean;
  repo?: string;
  link?: string;
  hint?: string;
  undoable?: boolean;
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
  const undoable = write && Boolean(reversalHint({ ...action, effect: classification.effect, tone: classification.tone }));
  const link = safeLink(action.arguments, action.result);
  const repo = repoOf(action.arguments);
  return {
    tone: failed ? "failed" : classification.tone === "unknown" ? "read" : classification.tone,
    effect: classification.effect === "write" ? "write" : "read",
    summary,
    write,
    ...(repo ? { repo } : {}),
    ...(link ? { link } : {}),
    ...(write ? { hint: undoable ? "Undo available" : "Undo not available yet", undoable } : {}),
    ...(span.before ? { before: span.before } : {}),
    ...(span.after ? { after: span.after } : {}),
    ...(action.client ? { client: action.client } : {}),
  };
}

/** One plain line for a change the agent reported, using the target and any before/after. */
export function claimSentence(input: ClaimSentenceInput): string {
  const title = clean(input.target);
  const detail = publicDetail(input.detail);
  if (input.before && input.after) {
    return `${claimVerb(input, title)} "${title}" · ${input.before} → ${input.after}`;
  }
  const base = looksLikeSentence(title) ? title.replace(/\.$/, "") : `${claimVerb(input, title)} "${title}"`;
  if (detail && !base.includes(detail)) return `${base} · ${detail}`;
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
  if (fresh.effect === "write") return fresh;
  if (fresh.effect === "read") return fresh;
  if (isStoredWrite(action.effect, action.tone)) {
    return {
      effect: "write",
      tone: action.tone === "created" || action.tone === "changed" || action.tone === "removed" ? action.tone : "changed",
      ...(action.verb ? { verb: action.verb } : {}),
    };
  }
  return { effect: "read", tone: "read" };
}

function isStoredWrite(effect: RecordedAction["effect"], tone: ActionTone): boolean {
  return effect === "write" && (tone === "created" || tone === "changed" || tone === "removed");
}

/** Pull a quoted subject out of an old stored sentence when the arguments no longer have it. */
export function quotedSubject(summary: string, tool: string): string | undefined {
  const match = /['"“”‘’]([^'"“”‘’]{1,80})['"“”‘’]/.exec(summary);
  const found = match?.[1]?.trim();
  if (!found || found === tool || found.includes("__")) return undefined;
  return found;
}
