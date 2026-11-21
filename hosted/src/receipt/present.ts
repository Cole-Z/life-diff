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
  client?: string;
}

/**
 * Classify again from the tool name. Calls stored before the classifier knew
 * a verb, and unknown non-writes, become lookups instead of their own line.
 */
export function presentAction(action: RecordedAction): PresentedAction {
  const classification = reclassify(action);
  const failed = action.ok === false;
  const subject = quotedSubject(action.summary, action.tool);
  const summary = phraseAction({
    upstream: action.upstream,
    tool: action.tool,
    classification,
    args: action.arguments,
    ...(subject ? { subject } : {}),
    ok: !failed,
    ...(action.error ? { error: action.error } : {}),
  });
  const write = !failed && classification.effect === "write";
  const hint = write ? reversalHint({ ...action, effect: classification.effect, tone: classification.tone }) : undefined;
  const link = safeLink(action.arguments, action.result);
  const repo = repoOf(action.arguments);
  return {
    tone: failed ? "failed" : classification.tone === "unknown" ? "read" : classification.tone,
    effect: classification.effect === "write" ? "write" : "read",
    summary,
    write,
    ...(repo ? { repo } : {}),
    ...(link ? { link } : {}),
    ...(hint ? { hint } : {}),
    ...(action.client ? { client: action.client } : {}),
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
