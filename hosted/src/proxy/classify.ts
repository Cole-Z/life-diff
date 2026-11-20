import { assertNever } from "../text";

export type ActionEffect = "read" | "write" | "unknown";
export type ActionTone = "created" | "changed" | "removed" | "read" | "unknown";

export interface Classification {
  effect: ActionEffect;
  tone: ActionTone;
  verb?: string;
}

const CREATED = new Set(["create", "add", "insert"]);
const CHANGED = new Set(["update", "move", "write", "post", "edit", "patch", "set"]);
const REMOVED = new Set(["delete", "remove", "send"]);
const READ = new Set(["get", "list", "search", "read", "fetch", "query"]);

/** A write verb wins over a read verb. delete, remove, and send win over other writes. */
export function classifyToolName(name: string): Classification {
  const tokens = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const removed = tokens.find((token) => REMOVED.has(token));
  if (removed) return { effect: "write", tone: "removed", verb: removed };
  const created = tokens.find((token) => CREATED.has(token));
  if (created) return { effect: "write", tone: "created", verb: created };
  const changed = tokens.find((token) => CHANGED.has(token));
  if (changed) return { effect: "write", tone: "changed", verb: changed };
  const read = tokens.find((token) => READ.has(token));
  if (read) return { effect: "read", tone: "read", verb: read };
  return { effect: "unknown", tone: "unknown" };
}

export function serviceLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "the service";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function plainAction(service: string, classification: Classification, subject: string | undefined, ok: boolean): string {
  const label = serviceLabel(service);
  if (!ok) {
    return subject ? `Tried to use ${label} for “${subject}”, and it failed.` : `Tried to use ${label}, and it failed.`;
  }
  switch (classification.tone) {
    case "created":
      return subject ? `Added “${subject}” in ${label}.` : `Added something in ${label}.`;
    case "changed":
      return subject ? `Changed “${subject}” in ${label}.` : `Changed something in ${label}.`;
    case "removed":
      if (classification.verb === "send") {
        return subject ? `Sent “${subject}” from ${label}.` : `Sent something from ${label}.`;
      }
      return subject ? `Deleted “${subject}” in ${label}.` : `Deleted something in ${label}.`;
    case "read":
      return subject ? `Looked up “${subject}” in ${label}.` : `Looked something up in ${label}.`;
    case "unknown":
      return subject ? `Used ${label} with “${subject}”.` : `Used ${label}.`;
    default:
      return assertNever(classification.tone, "action tone");
  }
}
