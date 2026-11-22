import { coreDeps } from "../app/runtime";
import { AppError, getReceipt, logAction } from "../app/service";
import { validateLifeDiffToken } from "../auth/worker";
import { readViewGrant } from "../crypto/view-token";
import type { Env } from "../env";
import { receiptCardKey } from "../receipt/card";
import { renderUndoPage } from "../receipt/page";
import { undoPlansFor } from "../receipt/story";
import { D1MetadataStore, R2ObjectStore } from "../storage/d1";
import { browserSession, viewGrantIsCurrent } from "./session";

const privateReceiptHeaders = { "cache-control": "private, no-store", "referrer-policy": "no-referrer" };

export async function handleData(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/me") return new Response("Not found", { status: 404 });
  const cardMatch = url.pathname.match(/^\/receipts\/([^/]+)\/card\.png$/);
  if (request.method === "GET" && cardMatch?.[1]) return serveReceiptCard(env, decodeURIComponent(cardMatch[1]), url.searchParams.get("t") ?? "");
  const viewed = url.pathname.match(/^\/receipts\/([^/]+)$/);
  const viewToken = url.searchParams.get("t");
  if (request.method === "GET" && viewed?.[1] && viewToken) {
    return serveSignedReceipt(env, decodeURIComponent(viewed[1]), viewToken);
  }
  const undoMatch = url.pathname.match(/^\/receipts\/([^/]+)\/undo(?:\/([^/]+))?$/);
  if (request.method === "GET" && undoMatch?.[1]) {
    const undoAuth = await requireUser(request, env, url);
    if (undoAuth instanceof Response) return undoAuth;
    if (!undoAuth.scope.includes("receipts:read")) return new Response("receipts:read is required", { status: 403 });
    return serveUndo(env, undoAuth, decodeURIComponent(undoMatch[1]), undoMatch[2] ? decodeURIComponent(undoMatch[2]) : undefined, url.origin);
  }
  const auth = await requireUser(request, env, url);
  if (auth instanceof Response) return auth;
  try {
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
        ...(typeof body.before === "string" ? { before: body.before } : {}),
        ...(typeof body.after === "string" ? { after: body.after } : {}),
        ...(typeof body.url === "string" ? { url: body.url } : {}),
      });
      return Response.json({ id: logged.id, target: logged.target });
    }
    const receiptMatch = url.pathname.match(/^\/receipts\/([^/]+?)(\.json)?$/);
    if (request.method === "GET" && receiptMatch?.[1]) {
      if (!auth.scope.includes("receipts:read")) return new Response("receipts:read is required", { status: 403 });
      const result = await getReceipt(coreDeps(env, auth), decodeURIComponent(receiptMatch[1]));
      if (url.pathname.endsWith(".json") || request.headers.get("accept")?.includes("application/json")) {
        return Response.json(result.receipt, { headers: privateReceiptHeaders });
      }
      return new Response(result.html, { headers: { ...privateReceiptHeaders, "content-type": "text/html; charset=utf-8" } });
    }
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Life Diff could not finish that request.";
    const status = error instanceof AppError ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
  return new Response("Not found", { status: 404 });
}

async function requireUser(request: Request, env: Env, url: URL): Promise<{ userId: string; login: string; scope: string[] } | Response> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1];
  if (!token && request.method === "GET" && url.pathname.startsWith("/receipts/")) {
    const session = await browserSession(request, env);
    if (session) return { userId: session.sub, login: session.login, scope: ["receipts:read"] };
  }
  if (!token) return new Response("Sign in required", { status: 401 });
  const validated = await validateLifeDiffToken(env, env.MCP_SERVER_URL, token);
  if (!validated?.props.userId || !validated.props.login) return new Response("Sign in required", { status: 401 });
  return { userId: validated.props.userId, login: validated.props.login, scope: validated.scope ?? [] };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function serveUndo(env: Env, auth: { userId: string; login: string }, receiptId: string, changeId: string | undefined, origin: string): Promise<Response> {
  try {
    const result = await getReceipt(coreDeps(env, auth), receiptId);
    const plans = undoPlansFor(result.receipt, origin);
    const chosen = changeId ? plans.filter((plan) => plan.changeId === changeId) : plans;
    if (changeId && chosen.length === 0) return new Response("Not found", { status: 404 });
    const html = renderUndoPage({ receiptId: result.receipt.id, plans: chosen });
    return new Response(html, { headers: { ...privateReceiptHeaders, "content-type": "text/html; charset=utf-8" } });
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Life Diff could not finish that request.";
    const status = error instanceof AppError ? 404 : 500;
    return new Response(message, { status });
  }
}

async function serveSignedReceipt(env: Env, id: string, token: string): Promise<Response> {
  const grant = await readViewGrant(env.COOKIE_SIGNING_KEY ?? "", token, Math.floor(Date.now() / 1000));
  if (!grant || grant.kind !== "receipt" || grant.id !== id) {
    return signedReceiptResponse("This link expired or is not valid.", 401);
  }
  const meta = new D1MetadataStore(env.DB);
  try {
    if (!await viewGrantIsCurrent(meta, grant)) return signedReceiptResponse("This link expired or is not valid.", 401);
    const result = await getReceipt(coreDeps(env, { userId: grant.userId, login: "viewer" }), id);
    if (!await viewGrantIsCurrent(meta, grant)) return signedReceiptResponse("This link expired or is not valid.", 401);
    return signedReceiptResponse(result.html);
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Life Diff could not finish that request.";
    return signedReceiptResponse(message, error instanceof AppError ? 404 : 500);
  }
}

function signedReceiptResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": status === 200 ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      ...privateReceiptHeaders,
    },
  });
}

async function serveReceiptCard(env: Env, id: string, token: string): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(token)) return new Response("Not found", { status: 404 });
  const meta = new D1MetadataStore(env.DB);
  const located = await meta.findReceipt(id);
  if (!located || !await meta.getAccessVersions(located.userId)) return new Response("Not found", { status: 404 });
  const objects = new R2ObjectStore(env.RECEIPTS);
  const json = await objects.get(located.jsonKey);
  let cardToken = "";
  try {
    cardToken = json ? ((JSON.parse(json) as { cardToken?: string }).cardToken ?? "") : "";
  } catch {
    cardToken = "";
  }
  if (cardToken !== token) return new Response("Not found", { status: 404 });
  const png = await objects.getBytes(receiptCardKey(located.jsonKey));
  if (!png) return new Response("Not found", { status: 404 });
  return new Response(png, { headers: { ...privateReceiptHeaders, "content-type": "image/png" } });
}
