import type { Env } from "../env";
import { readViewGrant } from "../crypto/view-token";
import { buildRoundup, loadRoundup, roundupCardKey } from "../receipt/roundup";
import { D1MetadataStore, R2ObjectStore } from "../storage/d1";
import { coreDeps } from "../app/runtime";
import { renderSignedOut } from "./pages";
import { browserSession } from "./session";
import { localClock } from "../time";

export async function handleRoundup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/roundup/card.png") return serveRoundupCard(env, url.searchParams.get("t") ?? "");
  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  const viewToken = url.searchParams.get("t");
  if (viewToken) return serveSignedDay(request, env, viewToken);
  const session = await browserSession(request, env);
  if (!session) return html(renderSignedOut(), 401);
  const dated = /^\/roundup\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
  const deps = {
    ...coreDeps(env, { userId: session.sub, login: session.login }),
    issuer: env.ISSUER,
    meta: new D1MetadataStore(env.DB),
    objects: new R2ObjectStore(env.RECEIPTS),
  };
  const settings = await deps.meta.getSettings(session.sub);
  const today = localClock(deps.now, settings.timeZone).date;
  const day = dated?.[1] ?? today;
  const stored = await loadRoundup(deps, day);
  const roundup = stored ?? await buildRoundup(deps, { date: day, save: day < today, finalize: day < today });
  return html(roundup.html);
}

async function serveSignedDay(request: Request, env: Env, token: string): Promise<Response> {
  const url = new URL(request.url);
  const grant = await readViewGrant(env.COOKIE_SIGNING_KEY ?? "", token, Math.floor(Date.now() / 1000));
  const dated = /^\/roundup\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
  if (!grant || grant.kind !== "day" || (dated?.[1] && dated[1] !== grant.id)) {
    return new Response("This link expired or is not valid.", { status: 401 });
  }
  const deps = {
    ...coreDeps(env, { userId: grant.userId, login: "viewer" }),
    issuer: env.ISSUER,
    meta: new D1MetadataStore(env.DB),
    objects: new R2ObjectStore(env.RECEIPTS),
  };
  const settings = await deps.meta.getSettings(grant.userId);
  const today = localClock(deps.now, settings.timeZone).date;
  const day = grant.id;
  const stored = day === today ? null : await loadRoundup(deps, day);
  const roundup = stored ?? await buildRoundup(deps, { date: day, save: false });
  return html(roundup.html);
}

async function serveRoundupCard(env: Env, token: string): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(token)) return new Response("Not found", { status: 404 });
  const png = await new R2ObjectStore(env.RECEIPTS).getBytes(roundupCardKey(token));
  if (!png) return new Response("Not found", { status: 404 });
  return new Response(png, { headers: { "content-type": "image/png", "cache-control": "private, max-age=300" } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
