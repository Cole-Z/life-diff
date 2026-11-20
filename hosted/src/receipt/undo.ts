import { pickSubject } from "../proxy/redact";
import type { RecordedAction } from "./types";

/** A hint the agent can follow. Life Diff does not run the undo. */
export function undoHint(action: Pick<RecordedAction, "tool" | "upstream" | "verb" | "tone" | "effect" | "arguments" | "result" | "summary">): string | undefined {
  const write = action.effect === "write" || action.tone === "created" || action.tone === "changed" || action.tone === "removed";
  if (!write) return undefined;
  if (action.tone === "removed" || action.verb === "send" || action.verb === "delete" || action.verb === "remove") {
    return undefined;
  }
  if (action.tone === "created" || action.verb === "create" || action.verb === "add" || action.verb === "insert") {
    const subject = pickSubject(action.arguments) || "it";
    const id = findId(action.arguments) ?? findId(action.result);
    const tool = `${action.upstream}__${inverseTool(action.tool)}`;
    const what = id ? `"${subject}" (${id})` : `"${subject}"`;
    return `Undo: delete ${what} via ${tool}.`;
  }
  if (action.tone === "changed" || action.verb === "update" || action.verb === "edit" || action.verb === "patch" || action.verb === "set") {
    const prior = priorPhrase(action.arguments);
    if (prior) return `Undo: restore ${prior} via ${action.upstream}__${action.tool}.`;
    return undefined;
  }
  return undefined;
}

function inverseTool(name: string): string {
  if (name.startsWith("create_")) return `delete_${name.slice("create_".length)}`;
  if (name.startsWith("add_")) return `remove_${name.slice("add_".length)}`;
  if (name.startsWith("insert_")) return `delete_${name.slice("insert_".length)}`;
  if (name.includes("create")) return name.replace("create", "delete");
  if (name.includes("add")) return name.replace("add", "remove");
  return `delete_${name}`;
}

function findId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const quoted = value.match(/"id"\s*:\s*"([^"]+)"/);
    if (quoted?.[1] && quoted[1] !== "[redacted]") return quoted[1].slice(0, 80);
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "eventId", "event_id", "messageId", "pageId", "resourceId"]) {
    const item = record[key];
    if (typeof item === "string" && item.trim() && item !== "[redacted]") return item.trim().slice(0, 80);
    if (typeof item === "number" && Number.isFinite(item)) return String(item);
  }
  return undefined;
}

function priorPhrase(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["previous", "prior", "before", "old"]) {
    const item = record[key];
    if (typeof item === "string" && item.trim()) return `"${item.trim().slice(0, 80)}"`;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const parts = Object.entries(item as Record<string, unknown>)
        .filter((entry): entry is [string, string | number] => typeof entry[1] === "string" || typeof entry[1] === "number")
        .slice(0, 4)
        .map(([field, fieldValue]) => `${field} “${String(fieldValue).slice(0, 40)}”`);
      if (parts.length > 0) return parts.join(", ");
    }
  }
  return undefined;
}
