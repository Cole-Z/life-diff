import { clip } from "../text";
import type { ActorRef, AppRef } from "../receipt/types";
import type { BranchSnap, CommentActivity, CommitActivity, FileActivity, InstallationRef, IssueSnap, PullSnap, RepoRef } from "./types";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function actorFrom(value: unknown): ActorRef | undefined {
  const record = asRecord(value);
  const login = str(record?.login);
  if (!login) return undefined;
  const actor: ActorRef = { login };
  const id = num(record?.id);
  const type = str(record?.type);
  if (id !== undefined) actor.id = id;
  if (type) actor.type = type;
  return actor;
}

export function appFrom(value: unknown): AppRef | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const app: AppRef = {};
  const id = num(record.id);
  const slug = str(record.slug);
  const name = str(record.name);
  if (id !== undefined) app.id = id;
  if (slug) app.slug = slug;
  if (name) app.name = name;
  if (app.id === undefined && !app.slug && !app.name) return undefined;
  return app;
}

export function botApp(actor: ActorRef | undefined): AppRef | undefined {
  if (!actor?.login.endsWith("[bot]")) return undefined;
  return { slug: actor.login.slice(0, -5), name: actor.login };
}

export function parseInstallation(value: unknown): InstallationRef | null {
  const record = asRecord(value);
  const id = num(record?.id);
  const account = actorFrom(record?.account);
  if (id === undefined || !account) return null;
  return { id, accountLogin: account.login };
}

export function parseRepo(value: unknown, installationId: number): RepoRef | null {
  const record = asRecord(value);
  const fullName = str(record?.full_name);
  if (!fullName || !fullName.includes("/")) return null;
  return { fullName, installationId, defaultBranch: str(record?.default_branch) ?? "main" };
}

export function parseBranch(value: unknown): BranchSnap | null {
  const record = asRecord(value);
  const name = str(record?.name);
  const commit = asRecord(record?.commit);
  const sha = str(commit?.sha);
  if (!name || !sha) return null;
  return { name, sha };
}

export function parsePull(value: unknown): PullSnap | null {
  const record = asRecord(value);
  const number = num(record?.number);
  const title = str(record?.title) ?? "";
  if (number === undefined) return null;
  const state = str(record?.state) === "closed" ? "closed" : "open";
  const head = asRecord(record?.head);
  const base = asRecord(record?.base);
  return {
    number,
    title,
    state,
    merged: record?.merged_at != null && record?.merged_at !== "",
    draft: record?.draft === true,
    ...(actorFrom(record?.user) ? { user: actorFrom(record?.user) } : {}),
    headRef: str(head?.ref) ?? "",
    headSha: str(head?.sha) ?? "",
    baseRef: str(base?.ref) ?? "",
    labels: labelsOf(record?.labels),
    ...(str(record?.updated_at) ? { updatedAt: str(record?.updated_at) } : {}),
    ...(str(record?.html_url) ? { htmlUrl: str(record?.html_url) } : {}),
  };
}

export function parseIssue(value: unknown): IssueSnap | null {
  const record = asRecord(value);
  if (!record || record.pull_request) return null;
  const number = num(record.number);
  if (number === undefined) return null;
  const state = str(record.state) === "closed" ? "closed" : "open";
  return {
    number,
    title: str(record.title) ?? "",
    state,
    ...(actorFrom(record.user) ? { user: actorFrom(record.user) } : {}),
    labels: labelsOf(record.labels),
    ...(str(record.updated_at) ? { updatedAt: str(record.updated_at) } : {}),
    ...(str(record.html_url) ? { htmlUrl: str(record.html_url) } : {}),
  };
}

export function parseCommit(value: unknown, repo: string): CommitActivity | null {
  const record = asRecord(value);
  const sha = str(record?.sha);
  if (!sha) return null;
  const commit = asRecord(record?.commit);
  const message = clip(str(commit?.message) ?? sha, 200).split("\n")[0] ?? sha;
  const author = actorFrom(record?.author);
  const committer = actorFrom(record?.committer);
  const gitAuthor = asRecord(commit?.author);
  const committedAt = str(asRecord(commit?.committer)?.date) ?? str(gitAuthor?.date);
  const via = botApp(author) ?? botApp(committer);
  return {
    repo,
    sha,
    message,
    ...(author ? { author } : {}),
    ...(committedAt ? { committedAt } : {}),
    ...(str(record?.html_url) ? { htmlUrl: str(record?.html_url) } : {}),
    ...(via ? { viaApp: via } : {}),
  };
}

export function parseComment(value: unknown, repo: string, kind: "issue" | "review"): CommentActivity | null {
  const record = asRecord(value);
  const id = num(record?.id);
  if (id === undefined) return null;
  const user = actorFrom(record?.user);
  const via = appFrom(record?.performed_via_github_app) ?? botApp(user);
  const number = issueNumber(record);
  return {
    repo,
    id,
    kind,
    ...(number !== undefined ? { number } : {}),
    body: clip(str(record?.body) ?? "", 280),
    ...(user ? { user } : {}),
    ...(str(record?.created_at) ? { createdAt: str(record?.created_at) } : {}),
    ...(str(record?.html_url) ? { htmlUrl: str(record?.html_url) } : {}),
    ...(via ? { viaApp: via } : {}),
  };
}

export function parseCompareFile(value: unknown, repo: string): FileActivity | null {
  const record = asRecord(value);
  const path = str(record?.filename);
  const status = str(record?.status);
  if (!path || !status) return null;
  return {
    repo,
    path,
    ...(str(record?.previous_filename) ? { previousPath: str(record?.previous_filename) } : {}),
    status,
    additions: num(record?.additions) ?? 0,
    deletions: num(record?.deletions) ?? 0,
    ...(str(record?.blob_url) ? { htmlUrl: str(record?.blob_url) } : {}),
  };
}

function labelsOf(value: unknown): string[] {
  return asArray(value)
    .map((label) => str(asRecord(label)?.name))
    .filter((name): name is string => Boolean(name))
    .sort();
}

function issueNumber(record: Record<string, unknown> | null): number | undefined {
  const url = str(record?.html_url) ?? str(record?.issue_url) ?? str(record?.pull_request_url);
  const match = url?.match(/\/(?:issues|pulls|pull)\/(\d+)/);
  return match?.[1] ? Number(match[1]) : undefined;
}
