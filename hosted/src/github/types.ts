import type { ActorRef, AppRef } from "../receipt/types";

export interface BranchSnap {
  name: string;
  sha: string;
}

export interface PullSnap {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  user?: ActorRef;
  headRef: string;
  headSha: string;
  baseRef: string;
  labels: string[];
  updatedAt?: string;
  htmlUrl?: string;
}

export interface IssueSnap {
  number: number;
  title: string;
  state: "open" | "closed";
  user?: ActorRef;
  labels: string[];
  updatedAt?: string;
  htmlUrl?: string;
}

export interface RepoSnap {
  fullName: string;
  installationId?: number;
  defaultBranch: string;
  defaultSha: string;
  branches: BranchSnap[];
  pulls: PullSnap[];
  issues: IssueSnap[];
}

export interface GitHubSnapshot {
  schemaVersion: "1.0.0";
  id: string;
  takenAt: string;
  login: string;
  repos: RepoSnap[];
  warnings: string[];
}

export interface CommitActivity {
  repo: string;
  sha: string;
  message: string;
  author?: ActorRef;
  committedAt?: string;
  htmlUrl?: string;
  viaApp?: AppRef;
}

export interface CommentActivity {
  repo: string;
  id: number;
  kind: "issue" | "review";
  number?: number;
  body: string;
  user?: ActorRef;
  createdAt?: string;
  htmlUrl?: string;
  viaApp?: AppRef;
}

export interface FileActivity {
  repo: string;
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  htmlUrl?: string;
  committedAt?: string;
  actor?: ActorRef;
}

export interface AfterRead {
  snapshot: GitHubSnapshot;
  commits: CommitActivity[];
  comments: CommentActivity[];
  files: FileActivity[];
  suppressedRepos: string[];
  truncatedChanges: boolean;
}

export interface InstallationRef {
  id: number;
  accountLogin: string;
}

export interface RepoRef {
  fullName: string;
  installationId: number;
  defaultBranch: string;
}

export interface GitHubApi {
  listInstallations(): Promise<InstallationRef[]>;
  listInstallationRepos(installationId: number): Promise<{ repos: RepoRef[]; truncated: boolean }>;
  listBranches(fullName: string): Promise<{ branches: BranchSnap[]; truncated: boolean }>;
  listPulls(fullName: string): Promise<{ pulls: PullSnap[]; truncated: boolean }>;
  listIssues(fullName: string, since?: string): Promise<{ issues: IssueSnap[]; truncated: boolean }>;
  listCommits(fullName: string, since: string, sha: string): Promise<{ commits: CommitActivity[]; truncated: boolean }>;
  compare(fullName: string, base: string, head: string): Promise<{ files: FileActivity[]; truncated: boolean }>;
  listIssueComments(fullName: string, since: string): Promise<{ comments: CommentActivity[]; truncated: boolean }>;
  listReviewComments(fullName: string, since: string): Promise<{ comments: CommentActivity[]; truncated: boolean }>;
}
