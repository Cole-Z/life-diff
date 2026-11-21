import { normalizeAction } from "../receipt/claims";
import { serviceFromTool } from "../receipt/names";
import { publicHttpsLink } from "../receipt/phrase";
import type { ClaimInput } from "../receipt/types";
import type { LoggedAction } from "../session/book";

export const ACTION_VALUES = ["added", "removed", "modified", "read"] as const;

const RESOURCES = new Set(["commit", "branch", "pull_request", "issue", "comment", "label", "file"]);

export interface ActionInput {
  tool: string;
  action?: string;
  target: string;
  detail?: string;
  resource?: string;
  repo?: string;
  before?: string;
  after?: string;
  url?: string;
}

export function validateAction(input: ActionInput): { action?: string; resource?: string; repo?: string; before?: string; after?: string; url?: string } {
  const tool = input.tool.trim();
  const target = input.target.trim();
  if (!tool) throw new Error("tool is required");
  if (tool.length > 200) throw new Error("tool is too long");
  if (!target) throw new Error("target is required");
  if (target.length > 500) throw new Error("target is too long");
  if (input.detail && input.detail.length > 2000) throw new Error("detail is too long");
  let action: string | undefined;
  if (input.action && input.action.trim()) {
    const folded = input.action.trim().toLowerCase();
    if (folded === "read") action = "read";
    else {
      const normalized = normalizeAction(input.action);
      if (!normalized) throw new Error("action must be added, removed, modified, or read");
      action = normalized;
    }
  }
  let resource: string | undefined;
  if (input.resource && input.resource.trim()) {
    const folded = input.resource.trim().toLowerCase().replaceAll("-", "_");
    const mapped = folded === "pr" || folded === "pull" ? "pull_request" : folded;
    if (!RESOURCES.has(mapped)) throw new Error("resource must be a GitHub resource Life Diff can check");
    resource = mapped;
  }
  let repo: string | undefined;
  if (input.repo && input.repo.trim()) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo.trim())) throw new Error("repo must look like owner/name");
    repo = input.repo.trim();
  }
  const before = bounded(input.before, "before");
  const after = bounded(input.after, "after");
  let url: string | undefined;
  if (input.url && input.url.trim()) {
    const link = publicHttpsLink(input.url);
    if (!link) throw new Error("url must be an https link");
    url = link;
  }
  return {
    ...(action ? { action } : {}),
    ...(resource ? { resource } : {}),
    ...(repo ? { repo } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(url ? { url } : {}),
  };
}

function bounded(value: string | undefined, name: string): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length > 200) throw new Error(`${name} is too long`);
  return trimmed;
}

export function actionsToClaims(actions: LoggedAction[]): ClaimInput[] {
  return actions.filter((action) => action.source !== "proxy" && action.action !== "read" && action.effect !== "read").map((action) => {
    const derived = serviceFromTool(action.tool);
    const detail = [action.tool ? `Tool ${action.tool}` : "", action.detail ?? ""].filter(Boolean).join(". ");
    const args = action.arguments && typeof action.arguments === "object" && !Array.isArray(action.arguments)
      ? action.arguments as Record<string, unknown>
      : undefined;
    const claim: ClaimInput = {
      id: action.id,
      service: derived.key === "github" ? (action.resource || "github") : derived.display,
      target: action.target,
    };
    if (action.action) claim.action = action.action;
    if (detail) claim.detail = detail;
    if (action.repo) claim.repo = action.repo;
    const before = textArg(args?.before);
    const after = textArg(args?.after);
    const url = textArg(args?.url);
    if (before) claim.before = before;
    if (after) claim.after = after;
    if (url) claim.url = url;
    return claim;
  });
}

function textArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
