export type ToolEffect = "read" | "write" | "unknown";
export type ActionTone = "added" | "changed" | "removed" | "read" | "unknown";

const WRITE = new Set(["create", "update", "delete", "send", "add", "remove", "move", "write", "post", "edit", "patch"]);
const READ = new Set(["get", "list", "search", "read", "fetch"]);

export function toolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function classifyTool(name: string): { effect: ToolEffect; tone: ActionTone } {
  const words = toolWords(name);
  for (const word of words) {
    if (!WRITE.has(word)) continue;
    return { effect: "write", tone: toneForWrite(word) };
  }
  for (const word of words) {
    if (READ.has(word)) return { effect: "read", tone: "read" };
  }
  return { effect: "unknown", tone: "unknown" };
}

function toneForWrite(word: string): ActionTone {
  if (word === "create" || word === "add") return "added";
  if (word === "delete" || word === "remove" || word === "send") return "removed";
  return "changed";
}

export function isToolEffect(value: unknown): value is ToolEffect {
  return value === "read" || value === "write" || value === "unknown";
}

export function isActionTone(value: unknown): value is ActionTone {
  return value === "added" || value === "changed" || value === "removed" || value === "read" || value === "unknown";
}
