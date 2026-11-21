import type { LoggedAction } from "../session/book";
import { serviceFromTool } from "./names";
import type { ActionEffect, ActionTone, RecordedAction } from "./types";

const EFFECTS = new Set<ActionEffect>(["read", "write", "unknown"]);
const TONES = new Set<ActionTone>(["created", "changed", "removed", "read", "unknown"]);

export function recordedFrom(action: LoggedAction): RecordedAction | null {
  const claim = action.source !== "proxy";
  const loggedRead = action.action === "read" || (claim && action.effect === "read");
  const effect: ActionEffect = loggedRead
    ? "read"
    : action.effect && EFFECTS.has(action.effect)
      ? action.effect
      : claim
        ? "write"
        : "unknown";
  const tone: ActionTone = loggedRead
    ? "read"
    : action.tone && TONES.has(action.tone)
      ? action.tone
      : claim
        ? toneFromAction(action.action)
        : "unknown";
  const derived = serviceFromTool(action.tool);
  const argumentsValue = action.arguments ?? (claim ? { subject: action.target } : undefined);
  return {
    id: action.id,
    time: action.loggedAt,
    upstream: action.upstream || derived.display,
    tool: action.tool,
    summary: action.summary || action.target,
    tone,
    effect,
    ...(action.verb ? { verb: action.verb } : {}),
    ok: action.ok !== false,
    status: action.status || (action.ok === false ? "error" : "ok"),
    ...(action.result ? { result: action.result } : {}),
    ...(action.error ? { error: action.error } : {}),
    ...(typeof action.durationMs === "number" ? { durationMs: action.durationMs } : {}),
    ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
    ...(action.client ? { client: action.client } : {}),
    source: claim ? "claim" : "proxy",
  };
}

function toneFromAction(action: string | undefined): ActionTone {
  switch (action) {
    case "added":
      return "created";
    case "removed":
      return "removed";
    case "read":
      return "read";
    case "modified":
      return "changed";
    default:
      return "changed";
  }
}
