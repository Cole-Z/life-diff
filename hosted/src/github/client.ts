import { asArray, asRecord, parseBranch, parseComment, parseCommit, parseCompareFile, parseInstallation, parseIssue, parsePull, parseRepo } from "./parse";
import type { BranchSnap, CommentActivity, CommitActivity, FileActivity, GitHubApi, InstallationRef, IssueSnap, PullSnap, RepoRef } from "./types";

const API = "https://api.github.com";
const PER_PAGE = 100;

export interface GitHubClientOptions {
  token: string;
  fetch?: typeof fetch;
  userAgent?: string;
}

export class GitHubClient implements GitHubApi {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? "life-diff";
  }

  async listInstallations(): Promise<InstallationRef[]> {
    const body = await this.getJson("/user/installations");
    return asArray(asRecord(body)?.installations).flatMap((item) => {
      const parsed = parseInstallation(item);
      return parsed ? [parsed] : [];
    });
  }

  async listInstallationRepos(installationId: number): Promise<{ repos: RepoRef[]; truncated: boolean }> {
    const { items, truncated } = await this.pages(`/user/installations/${installationId}/repositories`, 3, (body) => asArray(asRecord(body)?.repositories));
    return {
      truncated,
      repos: items.flatMap((item) => {
        const parsed = parseRepo(item, installationId);
        return parsed ? [parsed] : [];
      }),
    };
  }

  async listBranches(fullName: string): Promise<{ branches: BranchSnap[]; truncated: boolean }> {
    const { items, truncated } = await this.pages(`/repos/${fullName}/branches?per_page=${PER_PAGE}`, 1, asArray);
    const branches = items.flatMap((item) => {
      const parsed = parseBranch(item);
      return parsed ? [parsed] : [];
    });
    return { branches, truncated };
  }

  async listPulls(fullName: string): Promise<{ pulls: PullSnap[]; truncated: boolean }> {
    const { items, truncated } = await this.pages(`/repos/${fullName}/pulls?state=all&sort=updated&direction=desc&per_page=50`, 1, asArray);
    return {
      pulls: items.flatMap((item) => {
        const parsed = parsePull(item);
        return parsed ? [parsed] : [];
      }),
      truncated,
    };
  }

  async listIssues(fullName: string, since?: string): Promise<{ issues: IssueSnap[]; truncated: boolean }> {
    const sinceQuery = since ? `&since=${encodeURIComponent(since)}` : "";
    const { items, truncated } = await this.pages(`/repos/${fullName}/issues?state=all&sort=updated&direction=desc&per_page=50${sinceQuery}`, 1, asArray);
    return {
      issues: items.flatMap((item) => {
        const parsed = parseIssue(item);
        return parsed ? [parsed] : [];
      }),
      truncated,
    };
  }

  async listCommits(fullName: string, since: string, sha: string): Promise<{ commits: CommitActivity[]; truncated: boolean }> {
    const path = `/repos/${fullName}/commits?sha=${encodeURIComponent(sha)}&since=${encodeURIComponent(since)}&per_page=${PER_PAGE}`;
    const { items, truncated } = await this.pages(path, 1, asArray);
    return {
      commits: items.flatMap((item) => {
        const parsed = parseCommit(item, fullName);
        return parsed ? [parsed] : [];
      }),
      truncated,
    };
  }

  async compare(fullName: string, base: string, head: string): Promise<{ files: FileActivity[]; truncated: boolean }> {
    if (base === head) return { files: [], truncated: false };
    const body = await this.getJson(`/repos/${fullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    const record = asRecord(body);
    const files = asArray(record?.files).flatMap((item) => {
      const parsed = parseCompareFile(item, fullName);
      return parsed ? [parsed] : [];
    });
    const total = typeof record?.total_commits === "number" ? record.total_commits : files.length;
    return { files, truncated: files.length >= 300 || total > 250 };
  }

  async listIssueComments(fullName: string, since: string): Promise<{ comments: CommentActivity[]; truncated: boolean }> {
    return this.comments(fullName, "issue", `/repos/${fullName}/issues/comments?since=${encodeURIComponent(since)}&per_page=${PER_PAGE}&sort=created&direction=desc`);
  }

  async listReviewComments(fullName: string, since: string): Promise<{ comments: CommentActivity[]; truncated: boolean }> {
    return this.comments(fullName, "review", `/repos/${fullName}/pulls/comments?since=${encodeURIComponent(since)}&per_page=${PER_PAGE}&sort=created&direction=desc`);
  }

  private async comments(repo: string, kind: "issue" | "review", path: string): Promise<{ comments: CommentActivity[]; truncated: boolean }> {
    const { items, truncated } = await this.pages(path, 1, asArray);
    return {
      comments: items.flatMap((item) => {
        const parsed = parseComment(item, repo, kind);
        return parsed ? [parsed] : [];
      }),
      truncated,
    };
  }

  private async pages(path: string, maxPages: number, itemsOf: (body: unknown) => unknown[]): Promise<{ items: unknown[]; truncated: boolean }> {
    const items: unknown[] = [];
    let truncated = false;
    let next = path;
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.request(next);
      const batch = itemsOf(await response.json());
      items.push(...batch);
      const link = nextLink(response.headers.get("link"));
      if (!link) break;
      if (page === maxPages) {
        truncated = true;
        break;
      }
      next = link;
    }
    return { items, truncated };
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.request(path);
    return response.json();
  }

  private async request(pathOrUrl: string): Promise<Response> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${API}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com") {
      throw new Error("Refusing a GitHub URL that is not api.github.com");
    }
    const response = await this.fetchImpl(parsed, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": this.userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub request failed (${response.status}) for ${parsed.pathname}`);
    }
    return response;
  }
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    const url = match?.[1];
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && parsed.hostname === "api.github.com") return `${parsed.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  }
  return null;
}
