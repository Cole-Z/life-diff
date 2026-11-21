import type { LoggedAction } from "../session/book";
import type { ActionEffect, ActionTone, RecordedAction } from "./types";

const EFFECTS = new Set<ActionEffect>(["read", "write", "unknown"]);
const TONES = new Set<ActionTone>(["created", "changed", "removed", "read", "unknown"]);

export function recordedFrom(action: LoggedAction): RecordedAction | null {
  const loggedRead = action.action === "read";
  if (action.source !== "proxy" && !loggedRead) return null;
  const effect = loggedRead ? "read" : action.effect && EFFECTS.has(action.effect) ? action.effect : "unknown";
  const tone = loggedRead ? "read" : action.tone && TONES.has(action.tone) ? action.tone : "unknown";
  return {
    id: action.id,
    time: action.loggedAt,
    upstream: action.upstream || (loggedRead ? action.tool : "unknown"),
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
    ...(action.arguments !== undefined ? { arguments: action.arguments } : {}),
    ...(action.client ? { client: action.client } : {}),
    source: action.source === "claim" ? "claim" : "proxy",
  };
}
