import type { Env } from "../env";
import type { GitHubApi } from "../github/types";
import { dueDays } from "../time";
import { appDeps, coreDeps } from "./runtime";
import { closeIdleSession, sealOpenSession, type AppDeps } from "./service";
import { D1MetadataStore } from "../storage/d1";
import { buildRoundup } from "../receipt/roundup";

export async function finalizeDueDays(env: Env, now: Date): Promise<number> {
  const meta = new D1MetadataStore(env.DB);
  const users = await meta.listUsers();
  let count = 0;
  for (const user of users) {
    try {
      const settings = await meta.getSettings(user.id);
      const deps = await depsFor(env, user, now);
      await closeIdleSession(deps, deps.github);
      const saved = await meta.listDaily(user.id);
      const finalized = new Set(saved.filter((row) => row.finalizedAt).map((row) => row.day));
      const due = dueDays(now, settings.timeZone, settings.dayEnd, finalized);
      if (due.length === 0) continue;
      await sealOpenSession(deps);
      for (const day of due) {
        await buildRoundup({ ...deps, issuer: env.ISSUER }, { date: day, save: true, finalize: true });
        count += 1;
      }
    } catch {
      // One account does not block the others.
    }
  }
  return count;
}

async function depsFor(env: Env, user: { id: string; login: string }, now: Date): Promise<AppDeps> {
  try {
    return await appDeps(env, { userId: user.id, login: user.login }, now);
  } catch {
    return { ...coreDeps(env, { userId: user.id, login: user.login }, now), github: unavailableGithub() };
  }
}

function unavailableGithub(): GitHubApi {
  const fail = async (): Promise<never> => {
    throw new Error("GitHub is not signed in.");
  };
  return {
    listInstallations: fail,
    listInstallationRepos: fail,
    listBranches: fail,
    listPulls: fail,
    listIssues: fail,
    listCommits: fail,
    compare: fail,
    listIssueComments: fail,
    listReviewComments: fail,
  };
}
