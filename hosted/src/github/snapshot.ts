import type { AfterRead, GitHubApi, GitHubSnapshot, RepoRef, RepoSnap } from "./types";

export async function takeSnapshot(api: GitHubApi, input: {
  id: string;
  takenAt: string;
  login: string;
  maxRepos: number;
  repos?: string[];
}): Promise<GitHubSnapshot> {
  const wanted = new Set((input.repos ?? []).map((repo) => repo.toLowerCase()));
  const warnings: string[] = [];
  const installations = await api.listInstallations();
  const refs: RepoRef[] = [];
  for (const installation of installations) {
    const page = await api.listInstallationRepos(installation.id);
    if (page.truncated) warnings.push(`Repository list truncated for ${installation.accountLogin}.`);
    for (const repo of page.repos) {
      if (wanted.size > 0 && !wanted.has(repo.fullName.toLowerCase())) continue;
      refs.push(repo);
    }
  }
  if (wanted.size > 0) {
    const found = new Set(refs.map((repo) => repo.fullName.toLowerCase()));
    for (const name of wanted) {
      if (!found.has(name)) warnings.push(`Skipped ${name} because the GitHub App is not installed there.`);
    }
  }
  const selected = refs.slice(0, input.maxRepos);
  if (refs.length > selected.length) {
    warnings.push(`Repository list truncated to ${input.maxRepos}.`);
  }
  const repos: RepoSnap[] = [];
  for (const ref of selected) {
    repos.push(await readRepo(api, ref, warnings));
  }
  return {
    schemaVersion: "1.0.0",
    id: input.id,
    takenAt: input.takenAt,
    login: input.login,
    repos,
    warnings,
  };
}

export async function readAfter(api: GitHubApi, before: GitHubSnapshot, checkedAt: string): Promise<AfterRead> {
  const warnings: string[] = [];
  const suppressedRepos: string[] = [];
  const repos: RepoSnap[] = [];
  const commits = [];
  const comments = [];
  const files = [];
  let truncatedChanges = false;
  for (const prior of before.repos) {
    try {
      const ref = { fullName: prior.fullName, installationId: prior.installationId ?? 0, defaultBranch: prior.defaultBranch };
      const current = await readRepo(api, ref, warnings, before.takenAt);
      repos.push(current);
      const commitPage = await api.listCommits(prior.fullName, before.takenAt, current.defaultBranch);
      commits.push(...commitPage.commits);
      if (commitPage.truncated) truncatedChanges = true;
      const issueComments = await api.listIssueComments(prior.fullName, before.takenAt);
      const reviewComments = await api.listReviewComments(prior.fullName, before.takenAt);
      comments.push(...issueComments.comments, ...reviewComments.comments);
      if (issueComments.truncated || reviewComments.truncated) truncatedChanges = true;
      const compared = await api.compare(prior.fullName, prior.defaultSha, current.defaultSha);
      const newest = commitPage.commits.find((commit) => commit.committedAt)?.committedAt;
      const actor = commitPage.commits[0]?.author;
      files.push(...compared.files.map((file) => ({
        ...file,
        ...(newest ? { committedAt: newest } : {}),
        ...(actor ? { actor } : {}),
      })));
      if (compared.truncated) truncatedChanges = true;
    } catch {
      suppressedRepos.push(prior.fullName);
      warnings.push(`Could not re-read ${prior.fullName}.`);
    }
  }
  return {
    snapshot: {
      schemaVersion: "1.0.0",
      id: before.id,
      takenAt: checkedAt,
      login: before.login,
      repos,
      warnings,
    },
    commits,
    comments,
    files,
    suppressedRepos,
    truncatedChanges,
  };
}

async function readRepo(api: GitHubApi, ref: { fullName: string; installationId?: number; defaultBranch: string }, warnings: string[], since?: string): Promise<RepoSnap> {
  const branches = await api.listBranches(ref.fullName);
  if (branches.truncated) warnings.push(`Branch list truncated for ${ref.fullName}.`);
  const defaultBranch = branches.branches.find((branch) => branch.name === ref.defaultBranch) ?? branches.branches[0];
  const pulls = await api.listPulls(ref.fullName);
  const issues = await api.listIssues(ref.fullName, since);
  if (pulls.truncated) warnings.push(`Pull request list truncated for ${ref.fullName}.`);
  if (issues.truncated) warnings.push(`Issue list truncated for ${ref.fullName}.`);
  const relevantPulls = since ? pulls.pulls.filter((pull) => !pull.updatedAt || pull.updatedAt >= since || pull.state === "open") : pulls.pulls.filter((pull) => pull.state === "open");
  const relevantIssues = since ? issues.issues.filter((issue) => !issue.updatedAt || issue.updatedAt >= since || issue.state === "open") : issues.issues.filter((issue) => issue.state === "open");
  return {
    fullName: ref.fullName,
    ...(ref.installationId ? { installationId: ref.installationId } : {}),
    defaultBranch: defaultBranch?.name ?? ref.defaultBranch,
    defaultSha: defaultBranch?.sha ?? "",
    branches: branches.branches,
    pulls: relevantPulls,
    issues: relevantIssues,
    ...(branches.truncated ? { branchesTruncated: true } : {}),
    ...(pulls.truncated ? { pullsTruncated: true } : {}),
    ...(issues.truncated ? { issuesTruncated: true } : {}),
    ...(since ? { issuesPartial: true } : {}),
  };
}
