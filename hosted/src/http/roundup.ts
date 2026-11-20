import type { Env } from "../env";
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

async function serveRoundupCard(env: Env, token: string): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(token)) return new Response("Not found", { status: 404 });
  const png = await new R2ObjectStore(env.RECEIPTS).getBytes(roundupCardKey(token));
  if (!png) return new Response("Not found", { status: 404 });
  return new Response(png, { headers: { "content-type": "image/png", "cache-control": "private, max-age=300" } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
