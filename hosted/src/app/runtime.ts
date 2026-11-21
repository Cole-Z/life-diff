import type { Env } from "../env";
import { limitsFromEnv } from "../env";
import { loadAccessToken } from "../github/tokens";
import { githubForToken } from "./service";
import type { AppDeps, CoreDeps, SessionPort } from "./service";
import { UserSession } from "../session/user-session";
import { D1MetadataStore, R2ObjectStore } from "../storage/d1";
import type { SessionSweeper } from "../storage/retention";
import { isGitHubUserId } from "../text";

export function sessionStub(env: Env, userId: string): DurableObjectStub<UserSession> {
  if (!isGitHubUserId(userId)) throw new Error("Unknown user");
  const id = env.USER_SESSIONS.idFromName(userId);
  return env.USER_SESSIONS.get(id) as DurableObjectStub<UserSession>;
}

export function sessionPort(env: Env, userId: string): SessionPort {
  const stub = sessionStub(env, userId);
  return {
    getOpen: () => stub.getOpen(),
    start: (session) => stub.start(session),
    log: (sessionId, action) => stub.log(sessionId, action),
    list: (sessionId) => stub.list(sessionId),
    close: (sessionId) => stub.close(sessionId),
    touch: (sessionId, at) => stub.touch(sessionId, at),
    claimClose: (sessionId) => stub.claimClose(sessionId),
    abortClose: (sessionId) => stub.abortClose(sessionId),
  };
}

export function sessionSweeper(env: Env): SessionSweeper {
  return {
    abandon: async (userId, sessionId) => {
      if (!isGitHubUserId(userId)) return;
      await sessionStub(env, userId).abandon(sessionId);
    },
    wipe: async (userId) => {
      if (!isGitHubUserId(userId)) return;
      await sessionStub(env, userId).wipe();
    },
  };
}

export function coreDeps(env: Env, user: { userId: string; login: string }, now = new Date()): CoreDeps {
  const limits = limitsFromEnv(env);
  return {
    userId: user.userId,
    login: user.login,
    now,
    timeZone: "UTC",
    ...limits,
    sessions: sessionPort(env, user.userId),
    meta: new D1MetadataStore(env.DB),
    objects: new R2ObjectStore(env.RECEIPTS),
  };
}

export async function appDeps(env: Env, user: { userId: string; login: string }, now = new Date()): Promise<AppDeps> {
  const core = coreDeps(env, user, now);
  const token = await loadAccessToken({
    meta: core.meta,
    userId: user.userId,
    key: env.TOKEN_ENCRYPTION_KEY,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    now,
  });
  return { ...core, github: githubForToken(token) };
}
