import type { Env } from "../env";
import { readViewGrant } from "../crypto/view-token";
import { buildRoundup, loadRoundup } from "../receipt/roundup";
import { D1MetadataStore, R2ObjectStore } from "../storage/d1";
import { coreDeps } from "../app/runtime";
import { renderSignedOut } from "./pages";
import { browserSession, viewGrantIsCurrent } from "./session";
import { localClock } from "../time";

export async function handleRoundup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/roundup/card.png") return serveRoundupCard(env, url.searchParams.get("t") ?? "");
  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  const viewToken = url.searchParams.get("t");
  if (viewToken) return serveSignedDay(request, env, viewToken);
  const session = await browserSession(request, env);
  if (!session) return html(renderSignedOut("Today"), 401);
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
  const meta = new D1MetadataStore(env.DB);
  if (!grant || grant.kind !== "day" || dated?.[1] !== grant.id || !await viewGrantIsCurrent(meta, grant)) {
    return invalidView();
  }
  const deps = {
    ...coreDeps(env, { userId: grant.userId, login: "viewer" }),
    issuer: env.ISSUER,
    meta,
    objects: new R2ObjectStore(env.RECEIPTS),
  };
  const settings = await deps.meta.getSettings(grant.userId);
  const today = localClock(deps.now, settings.timeZone).date;
  const day = grant.id;
  const stored = day === today ? null : await loadRoundup(deps, day);
  const roundup = stored ?? await buildRoundup(deps, { date: day, save: false });
  if (!await viewGrantIsCurrent(meta, grant)) return invalidView();
  return html(roundup.html);
}

async function serveRoundupCard(env: Env, token: string): Promise<Response> {
  const grant = await readViewGrant(env.COOKIE_SIGNING_KEY ?? "", token, Math.floor(Date.now() / 1000));
  const meta = new D1MetadataStore(env.DB);
  if (!grant || grant.kind !== "day" || !await viewGrantIsCurrent(meta, grant)) return invalidView();
  const row = await meta.getDaily(grant.userId, grant.id);
  if (!row?.cardKey) return new Response("Not found", { status: 404, headers: privateViewHeaders });
  const png = await new R2ObjectStore(env.RECEIPTS).getBytes(row.cardKey);
  if (!png) return new Response("Not found", { status: 404, headers: privateViewHeaders });
  if (!await viewGrantIsCurrent(meta, grant)) return invalidView();
  return new Response(png, { headers: { ...privateViewHeaders, "content-type": "image/png" } });
}

function invalidView(): Response {
  return new Response("This link expired or is not valid.", { status: 401, headers: privateViewHeaders });
}

const privateViewHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
};

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...privateViewHeaders, "content-type": "text/html; charset=utf-8" } });
}
