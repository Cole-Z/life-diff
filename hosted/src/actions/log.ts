import { normalizeAction } from "../receipt/claims";
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
}

export function validateAction(input: ActionInput): { action?: string; resource?: string; repo?: string } {
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
  return { ...(action ? { action } : {}), ...(resource ? { resource } : {}), ...(repo ? { repo } : {}) };
}

export function actionsToClaims(actions: LoggedAction[]): ClaimInput[] {
  return actions.filter((action) => action.source !== "proxy" && action.action !== "read" && action.effect !== "read").map((action) => {
    const detail = [action.tool ? `Tool ${action.tool}` : "", action.detail ?? ""].filter(Boolean).join(". ");
    const claim: ClaimInput = {
      id: action.id,
      service: action.resource || "github",
      target: action.target,
    };
    if (action.action) claim.action = action.action;
    if (detail) claim.detail = detail;
    if (action.repo) claim.repo = action.repo;
    return claim;
  });
}
