import { readCookie, readSession, type SessionCookie } from "../crypto/cookie";
import type { Env } from "../env";

export async function browserSession(request: Request, env: Env): Promise<SessionCookie | null> {
  const token = readCookie(request.headers.get("cookie"));
  if (!token) return null;
  return readSession(env.COOKIE_SIGNING_KEY, token, Math.floor(Date.now() / 1000));
}
