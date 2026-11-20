import { HOSTED_VERSION, SCOPES } from "../constants";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appDeps, coreDeps } from "../app/runtime";
import { endSession, getReceipt, listReceipts, logAction, startSession, AppError } from "../app/service";
import type { Env } from "../env";
import { invalidateUpstreamCache, registerUpstreamTools } from "./upstream-tools";
import { addUpstream, listPublicUpstreams, removeUpstream } from "../proxy/upstreams";
import { D1MetadataStore } from "../storage/d1";
import type { ClaimInput } from "../receipt/types";
import type { GitHubApi } from "../github/types";
import { getMcpAuthContext } from "agents/mcp/server";

const claimSchema = z.object({
  id: z.string().optional(),
  service: z.string().optional(),
  action: z.string().optional(),
  target: z.string(),
  detail: z.string().optional(),
  repo: z.string().optional(),
});

export async function createLifeDiffServer(env: Env): Promise<McpServer> {
  const server = new McpServer({ name: "lifediff", version: HOSTED_VERSION });
  server.registerTool(
    "start_session",
    {
      description: "Snapshot GitHub repos the Life Diff app can read and open a session. Call this before the agent changes anything. Read-only.",
      inputSchema: z.object({
        repos: z.array(z.string()).max(25).optional(),
        timeZone: z.string().optional(),
      }),
    },
    async (input) => run(async () => {
      const deps = await appDeps(env, user());
      const result = await startSession(deps, input);
      return text(JSON.stringify(result, null, 2), result);
    }),
  );
  server.registerTool(
    "log_action",
    {
      description: "Record a tool call routed through Life Diff. Life Diff does not run the tool. The call becomes a claimed action and is checked against GitHub when the session ends.",
      inputSchema: z.object({
        sessionId: z.string().optional(),
        tool: z.string(),
        action: z.string().optional(),
        target: z.string(),
        detail: z.string().optional(),
        resource: z.string().optional(),
        repo: z.string().optional(),
      }),
    },
    async (input) => run(async () => {
      const logged = await logAction(coreDeps(env, user()), input);
      return text(`Logged ${logged.tool} against ${logged.target}.`, logged);
    }),
  );
  server.registerTool(
    "end_session",
    {
      description: "Close the session and write a receipt. Proxied tool calls are on the receipt. If this session snapshotted GitHub, the receipt also includes that verified diff.",
      inputSchema: z.object({
        sessionId: z.string().optional(),
        timeZone: z.string().optional(),
        claims: z.array(claimSchema).optional(),
        includeHtml: z.boolean().optional(),
      }),
    },
    async (input) => run(async () => {
      const who = user();
      const now = new Date();
      const core = coreDeps(env, who, now);
      const open = await core.sessions.getOpen();
      const deps = open?.snapshotKey ? await appDeps(env, who, now) : { ...core, github: idleGithub() };
      const result = await endSession(deps, {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        ...(input.claims ? { claims: input.claims as ClaimInput[] } : {}),
      });
      const payload = {
        summary: result.summary,
        receipt: result.receipt,
        url: receiptUrl(env, result.receipt.id),
        htmlUrl: receiptUrl(env, result.receipt.id),
        ...(input.includeHtml ? { html: result.html } : {}),
      };
      return text(`${result.summary}\n\n${receiptUrl(env, result.receipt.id)}`, payload);
    }),
  );
  server.registerTool(
    "get_receipt",
    {
      description: "Read a Life Diff receipt that end_session already saved.",
      inputSchema: z.object({
        receiptId: z.string(),
        includeHtml: z.boolean().optional(),
      }),
    },
    async (input) => run(async () => {
      const result = await getReceipt(coreDeps(env, user()), input.receiptId);
      const payload = {
        summary: result.receipt.counts,
        receipt: result.receipt,
        url: receiptUrl(env, result.receipt.id),
        htmlUrl: receiptUrl(env, result.receipt.id),
        ...(input.includeHtml ? { html: result.html } : {}),
      };
      return text(`Receipt ${result.receipt.id}\n${receiptUrl(env, result.receipt.id)}`, payload);
    }),
  );
  server.registerTool(
    "list_receipts",
    {
      description: "List Life Diff receipts for the signed-in user, newest first.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    },
    async (input) => run(async () => {
      const receipts = await listReceipts(coreDeps(env, user()), input.limit ?? 20);
      return text(receipts.map((receipt) => receipt.id).join("\n") || "No receipts yet.", { receipts });
    }),
  );
  server.registerTool(
    "add_upstream",
    {
      description: "Register an upstream MCP server. Its tools show up as <name>__<tool> and every call is recorded. Clients often cache the tool list, so reconnect if the new tools do not appear. The token is stored encrypted and is not returned.",
      inputSchema: z.object({
        name: z.string(),
        url: z.string(),
        token: z.string().optional(),
        header: z.string().optional(),
      }),
    },
    async (input) => run(async () => {
      const who = user();
      const added = await addUpstream(new D1MetadataStore(env.DB), who.userId, env.TOKEN_ENCRYPTION_KEY, new Date(), input);
      invalidateUpstreamCache(who.userId);
      try { server.sendToolListChanged(); } catch { /* stateless clients need to reconnect */ }
      return text(`Added ${added.name}. Tools will be named ${added.name}__<tool>. Reconnect if you do not see them yet.`, { upstream: added, reconnect: true });
    }),
  );
  server.registerTool(
    "list_upstreams",
    {
      description: "List upstream MCP servers registered for this Life Diff account. Tokens are not included.",
      inputSchema: z.object({}),
    },
    async () => run(async () => {
      const upstreams = await listPublicUpstreams(new D1MetadataStore(env.DB), user().userId);
      return text(upstreams.map((item) => `${item.name} ${item.url}`).join("\n") || "No upstreams yet.", { upstreams });
    }),
  );
  server.registerTool(
    "remove_upstream",
    {
      description: "Remove a registered upstream MCP server by name. Reconnect if the client still shows its tools.",
      inputSchema: z.object({ name: z.string() }),
    },
    async (input) => run(async () => {
      const who = user();
      await removeUpstream(new D1MetadataStore(env.DB), who.userId, input.name);
      invalidateUpstreamCache(who.userId);
      try { server.sendToolListChanged(); } catch { /* stateless clients need to reconnect */ }
      return text(`Removed ${input.name}. Reconnect if its tools are still listed.`, { removed: input.name, reconnect: true });
    }),
  );
  try {
    await registerUpstreamTools(server, env, user());
  } catch {
    // Built-in tools still answer when an upstream cannot be listed.
  }
  return server;
}

function idleGithub(): GitHubApi {
  const fail = async (): Promise<never> => {
    throw new AppError("This session has no GitHub snapshot.");
  };
  return {
    listInstallations: fail,
    listInstallationRepos: fail,
    listBranches: fail,
    listPulls: fail,
    listIssues: fail,
    listCommits: fail,
    compare: fail,
    listIssueComments: fail,
    listReviewComments: fail,
  };
}

function receiptUrl(env: Env, id: string): string {
  return `${env.ISSUER.replace(/\/$/, "")}/receipts/${id}`;
}

function user(): { userId: string; login: string } {
  const props = getMcpAuthContext()?.props;
  const userId = typeof props?.userId === "string" ? props.userId : "";
  const login = typeof props?.login === "string" ? props.login : "";
  if (!userId || !login) throw new AppError("Sign in again. This Life Diff token has no user.");
  const scope = Array.isArray(props?.scope) ? props.scope.filter((item): item is string => typeof item === "string") : [];
  if (!SCOPES.every((needed) => scope.includes(needed))) {
    throw new AppError("This token is missing Life Diff permission. Reconnect and approve receipts:read and sessions:write.");
  }
  return { userId, login };
}

async function run(work: () => Promise<{ content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> }>) {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof AppError || error instanceof Error ? error.message : "Life Diff failed";
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

function text(message: string, structured: unknown) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: structured as Record<string, unknown>,
  };
}
