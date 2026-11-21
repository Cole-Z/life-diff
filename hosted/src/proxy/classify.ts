import { displayName } from "../receipt/names";
import { phraseAction } from "../receipt/phrase";

export type ActionEffect = "read" | "write" | "unknown";
export type ActionTone = "created" | "changed" | "removed" | "moved" | "shared" | "read" | "unknown";

export interface Classification {
  effect: ActionEffect;
  tone: ActionTone;
  verb?: string;
}

const CREATED = new Set(["create", "add", "insert"]);
const MOVED = new Set(["move", "rename"]);
const SHARED = new Set(["share"]);
const CHANGED = new Set(["update", "write", "post", "edit", "patch", "set"]);
const REMOVED = new Set(["delete", "remove", "send", "unshare", "revoke", "trash"]);
const READ = new Set(["get", "list", "search", "read", "fetch", "query", "ask", "describe", "lookup", "check"]);

/** A write verb wins over a read verb. delete, remove, send, and trash win over other writes. */
export function classifyToolName(name: string): Classification {
  const tokens = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const removed = tokens.find((token) => REMOVED.has(token));
  if (removed) return { effect: "write", tone: "removed", verb: removed };
  const shared = tokens.find((token) => SHARED.has(token));
  if (shared) return { effect: "write", tone: "shared", verb: shared };
  const moved = tokens.find((token) => MOVED.has(token));
  if (moved) return { effect: "write", tone: "moved", verb: moved };
  const created = tokens.find((token) => CREATED.has(token));
  if (created) return { effect: "write", tone: "created", verb: created };
  const changed = tokens.find((token) => CHANGED.has(token));
  if (changed) return { effect: "write", tone: "changed", verb: changed };
  const read = tokens.find((token) => READ.has(token));
  if (read) return { effect: "read", tone: "read", verb: read };
  return { effect: "unknown", tone: "unknown" };
}

export function serviceLabel(name: string): string {
  return displayName(name);
}

export function plainAction(service: string, classification: Classification, subject: string | undefined, ok: boolean, tool?: string): string {
  return phraseAction({
    upstream: service,
    tool: tool ?? "",
    classification,
    ...(subject ? { subject } : {}),
    ok,
  });
}
