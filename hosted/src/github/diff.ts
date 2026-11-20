import { changeId } from "../ids";
import { confidenceAt, confidenceReason } from "../receipt/confidence";
import type { ActorRef, AppRef, Change, ChangeKind, FieldChange } from "../receipt/types";
import { clip, quoteName, safeHttpsLink } from "../text";
import type { AfterRead, BranchSnap, CommitActivity, CommentActivity, FileActivity, GitHubSnapshot, IssueSnap, PullSnap, RepoSnap } from "./types";

export interface DiffResult {
  changes: Change[];
  warnings: string[];
  repos: string[];
  truncatedSnapshot: boolean;
  truncatedChanges: boolean;
  suppressedRemovals: boolean;
}

export function diffGitHub(before: GitHubSnapshot, after: AfterRead, checkedAt: string): DiffResult {
  const warnings = [...after.snapshot.warnings];
  const suppressed = new Set(after.suppressedRepos);
  const beforeRepos = new Map(before.repos.map((repo) => [repo.fullName, repo]));
  const afterRepos = new Map(after.snapshot.repos.map((repo) => [repo.fullName, repo]));
  const names = [...new Set([...beforeRepos.keys(), ...afterRepos.keys()])].sort();
  const changes: Change[] = [];
  for (const name of names) {
    const prior = beforeRepos.get(name);
    const later = afterRepos.get(name);
    if (suppressed.has(name)) {
      warnings.push(`Could not re-read ${name}, so removals in that repository were not inferred.`);
      continue;
    }
    if (prior && later) {
      changes.push(...diffRepo(prior, later, before.takenAt, checkedAt));
    } else if (later && !prior) {
      changes.push(repoChange("added", later, before.takenAt, checkedAt));
    }
    // A repository missing from a later list is not a deletion. GitHub did not say it was removed.
  }
  const knownShas = new Set(before.repos.flatMap((repo) => repo.branches.map((branch) => branch.sha)));
  for (const commit of after.commits) {
    if (knownShas.has(commit.sha)) continue;
    changes.push(commitChange(commit, before.takenAt, checkedAt));
  }
  for (const comment of after.comments) {
    changes.push(commentChange(comment, before.takenAt, checkedAt));
  }
  for (const file of after.files) {
    const change = fileChange(file, before.takenAt, checkedAt);
    if (change) changes.push(change);
  }
  changes.sort((a, b) => a.repo.localeCompare(b.repo) || a.resourceType.localeCompare(b.resourceType) || a.resourceName.localeCompare(b.resourceName) || a.id.localeCompare(b.id));
  return {
    changes,
    warnings,
    repos: names.filter((name) => !suppressed.has(name) || beforeRepos.has(name)),
    truncatedSnapshot: before.warnings.some((warning) => warning.includes("truncated")) || after.snapshot.warnings.some((warning) => warning.includes("truncated")),
    truncatedChanges: after.truncatedChanges,
    suppressedRemovals: suppressed.size > 0,
  };
}

function diffRepo(before: RepoSnap, after: RepoSnap, startedAt: string, checkedAt: string): Change[] {
  const changes: Change[] = [];
  changes.push(...diffBranches(before, after, startedAt, checkedAt));
  changes.push(...diffPulls(before, after, startedAt, checkedAt));
  changes.push(...diffIssues(before, after, startedAt, checkedAt));
  return changes;
}

function diffBranches(before: RepoSnap, after: RepoSnap, startedAt: string, checkedAt: string): Change[] {
  const prior = new Map(before.branches.map((branch) => [branch.name, branch]));
  const later = new Map(after.branches.map((branch) => [branch.name, branch]));
  const changes: Change[] = [];
  for (const [name, branch] of later) {
    const old = prior.get(name);
    if (!old) changes.push(branchChange("added", after.fullName, branch, undefined, startedAt, checkedAt));
    else if (old.sha !== branch.sha) changes.push(branchChange("modified", after.fullName, branch, old, startedAt, checkedAt));
  }
  return changes;
}

function diffPulls(before: RepoSnap, after: RepoSnap, startedAt: string, checkedAt: string): Change[] {
  return diffNumbered(before.pulls, after.pulls, (item) => item.number, (kind, item, old) => pullChange(kind, after.fullName || before.fullName, item, old, startedAt, checkedAt));
}

function diffIssues(before: RepoSnap, after: RepoSnap, startedAt: string, checkedAt: string): Change[] {
  return diffNumbered(before.issues, after.issues, (item) => item.number, (kind, item, old) => issueChange(kind, after.fullName || before.fullName, item, old, startedAt, checkedAt));
}

function diffNumbered<T>(
  before: T[],
  after: T[],
  numberOf: (item: T) => number,
  build: (kind: ChangeKind, item: T, old: T | undefined) => Change | null,
): Change[] {
  const prior = new Map(before.map((item) => [numberOf(item), item]));
  const later = new Map(after.map((item) => [numberOf(item), item]));
  const changes: Change[] = [];
  for (const [, item] of later) {
    const old = prior.get(numberOf(item));
    const kind: ChangeKind = old ? "modified" : "added";
    const change = build(kind, item, old);
    if (change) changes.push(change);
  }
  return changes;
}

function repoChange(kind: ChangeKind, repo: RepoSnap, startedAt: string, checkedAt: string): Change {
  const name = repo.fullName;
  const summary = kind === "added" ? `Added repository ${quoteName(name)}.` : `Removed repository ${quoteName(name)} from the installation Life Diff can read.`;
  return baseChange({
    kind,
    repo: name,
    resourceType: "repository",
    resourceId: `repo:${name}`,
    resourceName: name,
    summary,
    fields: [{ field: "name", label: "Name", before: kind === "added" ? "" : name, after: kind === "removed" ? "" : name }],
    occurredAt: undefined,
    startedAt,
    checkedAt,
  });
}

function branchChange(kind: ChangeKind, repo: string, branch: BranchSnap, old: BranchSnap | undefined, startedAt: string, checkedAt: string): Change {
  const short = (sha: string) => sha.slice(0, 7);
  const fields: FieldChange[] = [{ field: "name", label: "Name", before: kind === "added" ? "" : branch.name, after: kind === "removed" ? "" : branch.name }];
  if (kind === "modified" && old) {
    fields.push({ field: "content", label: "Contents", before: short(old.sha), after: short(branch.sha) });
  }
  const summary = kind === "added"
    ? `Added branch ${quoteName(branch.name)} on ${repo}.`
    : kind === "removed"
      ? `Removed branch ${quoteName(branch.name)} on ${repo}.`
      : `Updated branch ${quoteName(branch.name)} on ${repo}.`;
  return baseChange({
    kind,
    repo,
    resourceType: "branch",
    resourceId: `branch:${repo}:${branch.name}`,
    resourceName: branch.name,
    summary,
    fields,
    occurredAt: undefined,
    startedAt,
    checkedAt,
  });
}

function pullChange(kind: ChangeKind, repo: string, pull: PullSnap, old: PullSnap | undefined, startedAt: string, checkedAt: string): Change | null {
  const fields: FieldChange[] = [];
  const labelsChanged = old ? !sameList(old.labels, pull.labels) : pull.labels.length > 0 && kind !== "removed";
  if (kind === "modified" && old) {
    if (old.title !== pull.title) fields.push({ field: "title", label: "Title", before: old.title, after: pull.title });
    if (statusOfPull(old) !== statusOfPull(pull)) fields.push({ field: "status", label: "Status", before: statusOfPull(old), after: statusOfPull(pull) });
    if (labelsChanged) fields.push({ field: "details", label: "Labels", before: old.labels.join(", "), after: pull.labels.join(", ") });
    if (old.headSha !== pull.headSha) fields.push({ field: "content", label: "Head", before: old.headSha.slice(0, 7), after: pull.headSha.slice(0, 7) });
    if (fields.length === 0) return null;
  } else {
    fields.push({ field: "title", label: "Title", before: kind === "added" ? "" : pull.title, after: kind === "removed" ? "" : pull.title });
    fields.push({ field: "status", label: "Status", before: kind === "added" ? "" : statusOfPull(pull), after: kind === "removed" ? "" : statusOfPull(pull) });
    if (pull.labels.length > 0 || kind !== "added") {
      fields.push({ field: "details", label: "Labels", before: kind === "added" ? "" : pull.labels.join(", "), after: kind === "removed" ? "" : pull.labels.join(", ") });
    }
  }
  const who = attribution(pull.user, undefined);
  const mergedNow = kind === "modified" && pull.merged && !old?.merged;
  const closed = kind === "modified" && old?.state === "open" && !old.merged && pull.state === "closed" && !pull.merged;
  const summary = kind === "added"
    ? `Opened pull request ${quoteName(pull.title)} (#${pull.number}) on ${repo}${who}.`
    : kind === "removed"
      ? `Removed pull request ${quoteName(pull.title)} (#${pull.number}) on ${repo}.`
      : mergedNow
        ? `Merged pull request ${quoteName(pull.title)} (#${pull.number}) on ${repo}${who}.`
        : closed
          ? `Closed pull request ${quoteName(pull.title)} (#${pull.number}) on ${repo}${who}.`
          : `Updated pull request ${quoteName(pull.title)} (#${pull.number}) on ${repo}${who}.`;
  return baseChange({
    kind,
    repo,
    resourceType: "pull_request",
    resourceId: `pull:${repo}:${pull.number}`,
    resourceName: pull.title,
    summary,
    fields,
    occurredAt: pull.updatedAt,
    startedAt,
    checkedAt,
    actor: pull.user,
    link: pull.htmlUrl,
    labelsChanged,
  });
}

function issueChange(kind: ChangeKind, repo: string, issue: IssueSnap, old: IssueSnap | undefined, startedAt: string, checkedAt: string): Change | null {
  const fields: FieldChange[] = [];
  const labelsChanged = old ? !sameList(old.labels, issue.labels) : issue.labels.length > 0 && kind !== "removed";
  if (kind === "modified" && old) {
    if (old.title !== issue.title) fields.push({ field: "title", label: "Title", before: old.title, after: issue.title });
    if (old.state !== issue.state) fields.push({ field: "status", label: "Status", before: old.state, after: issue.state });
    if (labelsChanged) fields.push({ field: "details", label: "Labels", before: old.labels.join(", "), after: issue.labels.join(", ") });
    if (fields.length === 0) return null;
  } else {
    fields.push({ field: "title", label: "Title", before: kind === "added" ? "" : issue.title, after: kind === "removed" ? "" : issue.title });
    fields.push({ field: "status", label: "Status", before: kind === "added" ? "" : issue.state, after: kind === "removed" ? "" : issue.state });
  }
  const who = attribution(issue.user, undefined);
  const closed = kind === "modified" && old?.state === "open" && issue.state === "closed";
  const summary = kind === "added"
    ? `Opened issue ${quoteName(issue.title)} (#${issue.number}) on ${repo}${who}.`
    : kind === "removed"
      ? `Removed issue ${quoteName(issue.title)} (#${issue.number}) on ${repo}.`
      : closed
        ? `Closed issue ${quoteName(issue.title)} (#${issue.number}) on ${repo}${who}.`
        : `Updated issue ${quoteName(issue.title)} (#${issue.number}) on ${repo}${who}.`;
  return baseChange({
    kind,
    repo,
    resourceType: "issue",
    resourceId: `issue:${repo}:${issue.number}`,
    resourceName: issue.title,
    summary,
    fields,
    occurredAt: issue.updatedAt,
    startedAt,
    checkedAt,
    actor: issue.user,
    link: issue.htmlUrl,
    labelsChanged,
  });
}

function commitChange(commit: CommitActivity, startedAt: string, checkedAt: string): Change {
  const who = attribution(commit.author, commit.viaApp);
  return baseChange({
    kind: "added",
    repo: commit.repo,
    resourceType: "commit",
    resourceId: `commit:${commit.repo}:${commit.sha}`,
    resourceName: commit.message || commit.sha.slice(0, 7),
    summary: `Added commit ${quoteName(commit.message || commit.sha.slice(0, 7))} on ${commit.repo}${who}.`,
    fields: [
      { field: "details", label: "Message", before: "", after: commit.message },
      { field: "content", label: "Contents", before: "", after: commit.sha.slice(0, 7) },
    ],
    occurredAt: commit.committedAt,
    startedAt,
    checkedAt,
    actor: commit.author,
    viaApp: commit.viaApp,
    link: commit.htmlUrl,
  });
}

function commentChange(comment: CommentActivity, startedAt: string, checkedAt: string): Change {
  const excerpt = clip(comment.body, 160);
  const where = comment.number ? ` on #${comment.number}` : "";
  const who = attribution(comment.user, comment.viaApp);
  return baseChange({
    kind: "added",
    repo: comment.repo,
    resourceType: "comment",
    resourceId: `comment:${comment.repo}:${comment.kind}:${comment.id}`,
    resourceName: excerpt || `Comment ${comment.id}`,
    summary: `Added a ${comment.kind === "review" ? "review comment" : "comment"}${where} in ${comment.repo}${who}.`,
    fields: [{ field: "details", label: "Comment", before: "", after: clip(comment.body, 280) }],
    occurredAt: comment.createdAt,
    startedAt,
    checkedAt,
    actor: comment.user,
    viaApp: comment.viaApp,
    link: comment.htmlUrl,
  });
}

function fileChange(file: FileActivity, startedAt: string, checkedAt: string): Change | null {
  const kind = fileKind(file.status);
  if (!kind) return null;
  const stat = `+${file.additions} −${file.deletions}`;
  const fields: FieldChange[] = [];
  if (file.previousPath && file.previousPath !== file.path) {
    fields.push({ field: "name", label: "Name", before: file.previousPath, after: file.path });
  } else {
    fields.push({ field: "name", label: "Name", before: kind === "added" ? "" : file.path, after: kind === "removed" ? "" : file.path });
  }
  fields.push({ field: "content", label: "Contents", before: "", after: stat });
  const verb = kind === "added" ? "Added" : kind === "removed" ? "Removed" : "Updated";
  const who = attribution(file.actor, undefined);
  return baseChange({
    kind,
    repo: file.repo,
    resourceType: "file",
    resourceId: `file:${file.repo}:${file.path}`,
    resourceName: file.path,
    summary: `${verb} file ${quoteName(file.path)} on ${file.repo} (${stat})${who}.`,
    fields,
    occurredAt: file.committedAt,
    startedAt,
    checkedAt,
    actor: file.actor,
    link: file.htmlUrl,
  });
}

function fileKind(status: string): ChangeKind | null {
  if (status === "added" || status === "copied") return "added";
  if (status === "removed") return "removed";
  if (status === "unchanged") return null;
  return "modified";
}

function statusOfPull(pull: PullSnap): string {
  if (pull.merged) return "merged";
  if (pull.draft && pull.state === "open") return "open (draft)";
  return pull.state;
}

function sameList(a: string[], b: string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function attribution(actor: ActorRef | undefined, via: AppRef | undefined): string {
  const app = via?.name || via?.slug;
  if (actor && app) return ` by ${actor.login} via ${app}`;
  if (actor) return ` by ${actor.login}`;
  if (app) return ` via ${app}`;
  return "";
}

function baseChange(input: {
  kind: ChangeKind;
  repo: string;
  resourceType: string;
  resourceId: string;
  resourceName: string;
  summary: string;
  fields: FieldChange[];
  occurredAt: string | undefined;
  startedAt: string;
  checkedAt: string;
  actor?: ActorRef;
  viaApp?: AppRef;
  link?: string;
  labelsChanged?: boolean;
}): Change {
  const confidence = confidenceAt(input.occurredAt, input.startedAt, input.checkedAt);
  const change: Change = {
    id: changeId("github", input.resourceId, input.kind),
    service: "github",
    kind: input.kind,
    resourceId: input.resourceId,
    resourceName: input.resourceName,
    summary: input.summary,
    fields: input.fields.filter((field) => field.before !== "" || field.after !== ""),
    confidence,
    confidenceReason: confidenceReason(confidence),
    resourceType: input.resourceType,
    repo: input.repo,
  };
  if (input.occurredAt) change.occurredAt = input.occurredAt;
  const link = safeHttpsLink(input.link);
  if (link) change.link = link;
  if (input.actor) change.actor = input.actor;
  if (input.viaApp) change.viaApp = input.viaApp;
  if (input.labelsChanged) change.labelsChanged = true;
  return change;
}
