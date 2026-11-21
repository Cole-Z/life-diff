import type { Change, RecordedAction } from "./types";

/**
 * A one-line reversal a person can ask for, only where the service can actually do it.
 * Life Diff does not run the reversal.
 */
export function reversalHint(action: Pick<RecordedAction, "tool" | "upstream" | "verb" | "tone" | "effect">): string | undefined {
  const write = action.effect === "write" || action.tone === "created" || action.tone === "changed" || action.tone === "removed";
  if (!write) return undefined;
  const tool = action.tool.toLowerCase();
  const upstream = action.upstream.toLowerCase().replace(/[\s-]+/g, "_");
  if (tool.includes("send") || action.verb === "send") return undefined;
  if (tool.includes("commit") && (action.tone === "created" || tool.includes("create"))) return "Revert this commit";
  if ((tool.includes("close_issue") || tool.includes("close_pull") || (tool.includes("close") && tool.includes("issue")))) return "Reopen";
  if ((upstream.includes("calendar") || tool.includes("event")) && (action.tone === "created" || tool.includes("create") || action.verb === "create")) {
    return "Delete this event";
  }
  if ((upstream.includes("drive") || tool.includes("file")) && (action.tone === "created" || tool.includes("create") || action.verb === "create")) {
    return "Move this file to trash";
  }
  return undefined;
}

export function reversalForChange(change: Pick<Change, "resourceType" | "kind" | "summary" | "fields">): string | undefined {
  const status = change.fields.find((field) => field.field === "status")?.after;
  if (change.resourceType === "commit" && change.kind === "added") return "Revert this commit";
  if ((change.resourceType === "issue" || change.resourceType === "pull_request") && (status === "closed" || change.summary.startsWith("Closed "))) {
    return "Reopen";
  }
  return undefined;
}
