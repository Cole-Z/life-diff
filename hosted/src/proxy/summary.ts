import { classifyTool, toolWords, type ActionTone } from "./classify";
import { assertNever, clip } from "../text";

const TARGET_KEYS = ["title", "name", "summary", "subject", "query", "q", "text", "message", "path", "url", "id", "prompt"];

export function serviceLabel(name: string): string {
  const words = name.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return "the service";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function argumentTarget(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value.trim(), 80);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim()) return clip(value.trim(), 80);
  }
  return "";
}

export function plainAction(input: { upstream: string; tool: string; args: unknown; ok: boolean }): string {
  const service = serviceLabel(input.upstream);
  const target = argumentTarget(input.args);
  const { tone } = classifyTool(input.tool);
  const quoted = target ? ` ${JSON.stringify(target)}` : "";
  if (!input.ok) {
    const verb = failureVerb(tone, input.tool);
    return target
      ? `Tried to ${verb} ${JSON.stringify(target)} in ${service}, and ${service} reported an error.`
      : `Tried to ${verb} something in ${service}, and ${service} reported an error.`;
  }
  switch (tone) {
    case "added":
      return target ? `Created${quoted} in ${service}.` : `Created something in ${service}.`;
    case "changed":
      return target ? `Changed${quoted} in ${service}.` : `Changed something in ${service}.`;
    case "removed":
      if (toolWords(input.tool).includes("send")) {
        return target ? `Sent${quoted} in ${service}.` : `Sent something in ${service}.`;
      }
      return target ? `Deleted${quoted} in ${service}.` : `Deleted something in ${service}.`;
    case "read":
      return target ? `Looked up${quoted} in ${service}.` : `Looked something up in ${service}.`;
    case "unknown":
      return target ? `Used ${service} on${quoted}.` : `Used a tool in ${service}.`;
    default:
      return assertNever(tone, "action tone");
  }
}

function failureVerb(tone: ActionTone, tool: string): string {
  switch (tone) {
    case "added":
      return "create";
    case "changed":
      return "change";
    case "removed":
      return toolWords(tool).includes("send") ? "send" : "delete";
    case "read":
      return "look up";
    case "unknown":
      return "use";
    default:
      return assertNever(tone, "action tone");
  }
}
