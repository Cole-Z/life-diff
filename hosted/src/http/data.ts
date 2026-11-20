import { coreDeps } from "../app/runtime";
import { AppError, getReceipt, logAction } from "../app/service";
import { eraseUser, oauthServer } from "../auth/worker";
import type { Env } from "../env";

export async function handleData(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const auth = await requireUser(request, env);
  if (auth instanceof Response) return auth;
  try {
    if (request.method === "DELETE" && url.pathname === "/v1/me") {
      await eraseUser(env, auth.userId);
      return Response.json({ deleted: true });
    }
    const actionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/actions$/);
    if (request.method === "POST" && actionMatch?.[1]) {
      if (!auth.scope.includes("sessions:write")) return new Response("sessions:write is required", { status: 403 });
      const body = await request.json() as Record<string, unknown>;
      const logged = await logAction(coreDeps(env, auth), {
        sessionId: decodeURIComponent(actionMatch[1]),
        tool: stringField(body.tool),
        target: stringField(body.target),
        ...(typeof body.action === "string" ? { action: body.action } : {}),
        ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
        ...(typeof body.resource === "string" ? { resource: body.resource } : {}),
        ...(typeof body.repo === "string" ? { repo: body.repo } : {}),
      });
      return Response.json({ id: logged.id, target: logged.target });
    }
    const receiptMatch = url.pathname.match(/^\/receipts\/([^/]+?)(\.json)?$/);
    if (request.method === "GET" && receiptMatch?.[1]) {
      if (!auth.scope.includes("receipts:read")) return new Response("receipts:read is required", { status: 403 });
      const result = await getReceipt(coreDeps(env, auth), decodeURIComponent(receiptMatch[1]));
      if (url.pathname.endsWith(".json") || request.headers.get("accept")?.includes("application/json")) {
        return Response.json(result.receipt);
      }
      return new Response(result.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });
    }
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Life Diff could not finish that request.";
    const status = error instanceof AppError ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
  return new Response("Not found", { status: 404 });
}

async function requireUser(request: Request, env: Env): Promise<{ userId: string; login: string; scope: string[] } | Response> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1];
  if (!token) return new Response("Sign in required", { status: 401 });
  const validated = env.AUTH_SERVER
    ? await env.AUTH_SERVER.validateToken(env.MCP_SERVER_URL, token)
    : await oauthServer(env).validateToken(env.MCP_SERVER_URL, token, env);
  if (!validated?.props.userId || !validated.props.login) return new Response("Sign in required", { status: 401 });
  return { userId: validated.props.userId, login: validated.props.login, scope: validated.scope ?? [] };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
