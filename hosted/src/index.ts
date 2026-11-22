import { createMcpHandler } from "agents/mcp/server";
import { insufficientScope, OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import { oauthServer, handleApp, AuthServer } from "./auth/worker";
import { SCOPES } from "./constants";
import type { AuthProps, Env } from "./env";
import { handleData } from "./http/data";
import { renderMcpBrowserPage } from "./http/pages";
import { classify } from "./http/routes";
import { createLifeDiffServer } from "./mcp/server";
import { sessionSweeper } from "./app/runtime";
import { D1MetadataStore, R2ObjectStore } from "./storage/d1";
import { finalizeDueDays } from "./app/finalize";
import { runRetention } from "./storage/retention";
import { UserSession } from "./session/user-session";

export { AuthServer, UserSession };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const kind = classify(new URL(request.url).pathname);
    if (kind === "mcp" || kind === "resource-metadata") {
      const response = await resourceServer(env).fetch(request, env, ctx);
      if (kind === "mcp" && request.method === "GET" && response.status === 401 && !hasBearer(request)) {
        return mcpBrowserPage(response, env.MCP_SERVER_URL);
      }
      return response;
    }
    if (kind === "data") return handleData(request, env);
    return handleApp(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, new Date(event.scheduledTime)));
  },
};

function resourceServer(env: Env): OAuthResourceServer<Env, AuthProps> {
  return new OAuthResourceServer<Env, AuthProps>({
    resourceMetadata: {
      resource: env.MCP_SERVER_URL,
      authorization_servers: [env.ISSUER],
      resource_name: "Life Diff",
    },
    requiredScopes: [...SCOPES],
    validateToken: (bound) => {
      if (bound.AUTH_SERVER) return bound.AUTH_SERVER.validateToken.bind(bound.AUTH_SERVER);
      return (resource, token) => oauthServer(bound).validateToken(resource, token, bound);
    },
    handler: {
      async fetch(request, bound, ctx) {
        if (!SCOPES.every((scope) => ctx.auth.scope.includes(scope))) {
          return insufficientScope(ctx.auth, [...SCOPES]);
        }
        const mcp = createMcpHandler(() => createLifeDiffServer(bound), {
          route: "/mcp",
          authContext: {
            props: {
              userId: ctx.props.userId,
              login: ctx.props.login,
              scope: ctx.auth.scope,
            },
          },
        });
        return mcp(request, bound, ctx);
      },
    },
  });
}

function hasBearer(request: Request): boolean {
  return /^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "");
}

function mcpBrowserPage(response: Response, endpoint: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("referrer-policy", "no-referrer");
  return new Response(renderMcpBrowserPage(endpoint), { status: 401, statusText: response.statusText, headers });
}

async function runCron(env: Env, now: Date): Promise<void> {
  await runRetention({
    meta: new D1MetadataStore(env.DB),
    objects: new R2ObjectStore(env.RECEIPTS),
    sessions: sessionSweeper(env),
    nowIso: now.toISOString(),
    limit: 100,
  });
  await finalizeDueDays(env, now);
  await oauthServer(env).purgeExpiredData(env, { batchSize: 50 });
}
