import type { Env } from "../env";
import { buildRoundup, loadRoundup, roundupCardKey } from "../receipt/roundup";
import { markerFor, type StoryLine } from "../receipt/story";
import { D1MetadataStore, R2ObjectStore } from "../storage/d1";
import { coreDeps } from "../app/runtime";
import { renderRoundup, renderSignedOut } from "./pages";
import { browserSession } from "./session";

export async function handleRoundup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/roundup/card.png") return serveRoundupCard(env, url.searchParams.get("t") ?? "");
  if (request.method !== "GET") return new Response("Not found", { status: 404 });
  const session = await browserSession(request, env);
  if (!session) return html(renderSignedOut(), 401);
  const deps = {
    ...coreDeps(env, { userId: session.sub, login: session.login }),
    issuer: env.ISSUER,
    meta: new D1MetadataStore(env.DB),
    objects: new R2ObjectStore(env.RECEIPTS),
  };
  const stored = await loadRoundup(deps);
  const roundup = stored ?? await buildRoundup(deps, { save: false });
  const lines = roundup.lines.map((line) => ({
    service: line.service,
    marker: markerFor(line.tone),
    text: lineText(line),
    color: colorFor(line.tone),
  }));
  return html(renderRoundup(session.login, roundup.since, lines, roundup.imageUrl, !stored));
}

async function serveRoundupCard(env: Env, token: string): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(token)) return new Response("Not found", { status: 404 });
  const png = await new R2ObjectStore(env.RECEIPTS).getBytes(roundupCardKey(token));
  if (!png) return new Response("Not found", { status: 404 });
  return new Response(png, { headers: { "content-type": "image/png", "cache-control": "private, max-age=300" } });
}

function lineText(line: StoryLine): string {
  const id = line.id ? `${line.id} ` : "";
  const undo = line.undo ? ` ${line.undo}` : "";
  return `${id}${line.summary}${undo}`;
}

function colorFor(tone: StoryLine["tone"]): string {
  switch (tone) {
    case "created":
      return "#0f5c32";
    case "changed":
      return "#6b4300";
    case "removed":
      return "#8d1c1c";
    default:
      return "#5c564c";
  }
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
