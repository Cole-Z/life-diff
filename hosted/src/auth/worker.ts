import { WorkerEntrypoint } from "cloudflare:workers";
import {
  AuthorizationError,
  OAuthAuthorizationServer,
  authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";
import { bindFetch } from "../bind-fetch";
import { SCOPES } from "../constants";
import { clearSessionCookieHeader, readCookie, readSession, sessionCookieHeader, signSession } from "../crypto/cookie";
import { codeChallengeS256, randomVerifier } from "../crypto/pkce";
import type { Env } from "../env";
import { authProps, exchangeGithubCode, fetchGithubProfile, githubAuthorizeUrl } from "../github/oauth";
import { sealCredentials } from "../github/tokens";
import { D1MetadataStore, R2ObjectStore } from "../storage/d1";
import { deleteUserData } from "../storage/retention";
import { revokeAllGrants } from "./grants";
import { renderAccount, renderConsentPage, renderDeleted, renderHome, renderPrivacy, renderSignedOut } from "../http/pages";
import { sessionSweeper } from "../app/runtime";

const SESSION_SECONDS = 7 * 24 * 60 * 60;

export function oauthServer(env: Env): OAuthAuthorizationServer<Env> {
  return new OAuthAuthorizationServer<Env>({
    issuer: env.ISSUER,
    resources: [env.MCP_SERVER_URL],
    scopesSupported: [...SCOPES],
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: "/oauth/register",
  });
}

export class AuthServer extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return handleApp(request, this.env, this.ctx);
  }

  validateToken(resource: string, token: string) {
    return oauthServer(this.env).validateToken(resource, token, this.env);
  }
}

export async function handleApp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/authorize") return await authorize(request, env);
    if (url.pathname === "/callback") return await callback(request, env);
    if (url.pathname === "/account") return await account(request, env);
    if (url.pathname === "/account/delete") return await deleteAccount(request, env);
    if (url.pathname === "/privacy") return html(renderPrivacy());
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/") return html(renderHome());
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
      return new Response(error.description, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    console.error("auth failed", error instanceof Error ? error.name : "error");
    return new Response("Life Diff could not finish that request.", { status: 500 });
  }
  return oauthServer(env).fetch(request, env, ctx);
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = oauthServer(env).getOAuthApi(env);
  if (request.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    const page = renderConsentPage({
      clientName: details.clientName,
      redirectHost: details.redirectHost,
      redirectIsLoopback: details.redirectIsLoopback,
      scope: details.scope,
      ...(details.clientDomain ? { clientDomain: details.clientDomain } : {}),
    }, consent.handle);
    consent.headers.set("content-type", "text/html; charset=utf-8");
    return new Response(page, { headers: consent.headers });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, {
    scope: form.getAll("scope").map(String).filter((scope) => (SCOPES as readonly string[]).includes(scope)),
  });
  const verifier = randomVerifier();
  const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
  const location = githubAuthorizeUrl({
    clientId: env.GITHUB_APP_CLIENT_ID,
    redirectUri: new URL("/callback", request.url).toString(),
    state: upstream.state,
    codeChallenge: await codeChallengeS256(verifier),
  });
  upstream.headers.set("location", location);
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function callback(request: Request, env: Env): Promise<Response> {
  const oauth = oauthServer(env).getOAuthApi(env);
  const resumed = await oauth.finishUpstream<{ verifier?: string }>(request);
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    resumed.headers.set("location", authorizationErrorRedirect(resumed.request, "access_denied", "GitHub authorization was declined"));
    return new Response(null, { status: 302, headers: resumed.headers });
  }
  const code = url.searchParams.get("code");
  if (!code || !resumed.data?.verifier) return new Response("GitHub did not return a code", { status: 400 });
  const githubFetch = bindFetch();
  const tokens = await exchangeGithubCode(githubFetch, {
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    code,
    redirectUri: new URL("/callback", request.url).toString(),
    codeVerifier: resumed.data.verifier,
  });
  const profile = await fetchGithubProfile(githubFetch, tokens.accessToken);
  const props = authProps(profile);
  const now = new Date();
  const meta = new D1MetadataStore(env.DB);
  await meta.upsertUser({ id: props.userId, login: props.login, now: now.toISOString() });
  await meta.saveCredentials(await sealCredentials(env.TOKEN_ENCRYPTION_KEY, props.userId, tokens, now));
  const completed = await oauth.completeAuthorization({
    request: resumed.request,
    userId: props.userId,
    metadata: {},
    scope: resumed.request.scope,
    props,
  });
  resumed.headers.set("location", completed.redirectTo);
  const csrf = crypto.randomUUID();
  const cookie = await signSession(env.COOKIE_SIGNING_KEY, {
    sub: props.userId,
    login: props.login,
    csrf,
    exp: Math.floor(now.getTime() / 1000) + SESSION_SECONDS,
  });
  resumed.headers.append("set-cookie", sessionCookieHeader(cookie, SESSION_SECONDS));
  return new Response(null, { status: 302, headers: resumed.headers });
}

async function account(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return html(renderSignedOut());
  return html(renderAccount(session.login, session.csrf));
}

async function deleteAccount(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const session = await currentSession(request, env);
  if (!session) return html(renderSignedOut(), 401);
  const form = await request.formData();
  if (form.get("confirm") !== "delete" || form.get("csrf") !== session.csrf) {
    return new Response("The deletion form did not match this session.", { status: 400 });
  }
  await eraseUser(env, session.sub);
  return html(renderDeleted(), 200, clearSessionCookieHeader());
}

export async function eraseUser(env: Env, userId: string): Promise<void> {
  const meta = new D1MetadataStore(env.DB);
  await deleteUserData({
    meta,
    objects: new R2ObjectStore(env.RECEIPTS),
    sessions: sessionSweeper(env),
    userId,
  });
  await revokeAllGrants(oauthServer(env).getOAuthApi(env), userId);
}

async function currentSession(request: Request, env: Env) {
  const token = readCookie(request.headers.get("cookie"));
  if (!token) return null;
  return readSession(env.COOKIE_SIGNING_KEY, token, Math.floor(Date.now() / 1000));
}

function html(body: string, status = 200, setCookie?: string): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(body, { status, headers });
}
