import { D1MetadataStore } from "../storage/d1";
import type { Env } from "../env";
import { AppError } from "../app/service";
import { renderSettings, renderSignedOut } from "./pages";
import { browserSession } from "./session";
import { addUpstream, listPublicUpstreams, removeUpstream } from "../proxy/upstreams";
import { invalidateUpstreamCache } from "../mcp/upstream-tools";

export async function handleSettings(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const session = await browserSession(request, env);
  if (!session) return html(renderSignedOut(), 401);
  const meta = new D1MetadataStore(env.DB);
  try {
    if (request.method === "POST" && url.pathname === "/settings") {
      const form = await request.formData();
      if (form.get("csrf") !== session.csrf) return html(await page(meta, session, "The form did not match this session."), 400);
      const token = String(form.get("token") ?? "");
      await addUpstream(meta, session.sub, env.TOKEN_ENCRYPTION_KEY, new Date(), {
        name: String(form.get("name") ?? ""),
        url: String(form.get("url") ?? ""),
        ...(token.trim() ? { token } : {}),
      });
      invalidateUpstreamCache(session.sub);
      return redirect("/settings");
    }
    if (request.method === "POST" && url.pathname === "/settings/remove") {
      const form = await request.formData();
      if (form.get("csrf") !== session.csrf) return html(await page(meta, session, "The form did not match this session."), 400);
      await removeUpstream(meta, session.sub, String(form.get("name") ?? ""));
      invalidateUpstreamCache(session.sub);
      return redirect("/settings");
    }
    if (request.method !== "GET" || url.pathname !== "/settings") return new Response("Not found", { status: 404 });
    return html(await page(meta, session));
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Life Diff could not save that upstream.";
    return html(await page(meta, session, message), 400);
  }
}

async function page(meta: D1MetadataStore, session: { sub: string; login: string; csrf: string }, error?: string): Promise<string> {
  const upstreams = await listPublicUpstreams(meta, session.sub);
  return renderSettings(session.login, session.csrf, upstreams, error);
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}
