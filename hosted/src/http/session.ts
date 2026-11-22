import { readCookie, readSession, type SessionCookie } from "../crypto/cookie";
import type { ViewGrant } from "../crypto/view-token";
import type { Env } from "../env";
import { D1MetadataStore } from "../storage/d1";

export async function browserSession(request: Request, env: Env): Promise<SessionCookie | null> {
  const token = readCookie(request.headers.get("cookie"));
  if (!token) return null;
  const session = await readSession(env.COOKIE_SIGNING_KEY, token, Math.floor(Date.now() / 1000));
  if (!session) return null;
  const versions = await new D1MetadataStore(env.DB).getAccessVersions(session.sub);
  return versions?.accountVersion === (session.accountVersion ?? "") ? session : null;
}

export async function viewGrantIsCurrent(meta: D1MetadataStore, grant: ViewGrant): Promise<boolean> {
  const versions = await meta.getAccessVersions(grant.userId);
  return versions?.historyVersion === grant.historyVersion;
}
