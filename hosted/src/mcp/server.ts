import { HOSTED_VERSION, SCOPES } from "../constants";
import { McpServer, type ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appDeps, coreDeps } from "../app/runtime";
import { endSession, getReceipt, listReceipts, logAction, recordProxyCall, startSession } from "../app/service";
import { AppError } from "../app/service";
import type { Env } from "../env";
import type { ClaimInput } from "../receipt/types";
import { callUpstreamTool, listUpstreamTools, type ListedTool, type UpstreamTarget } from "../proxy/forward";
import { namespacedTool } from "../proxy/namespace";
import { addUpstream, listUpstreamPublic, loadUpstreamSecrets, removeUpstream } from "../proxy/registry";
import { jsonSchema } from "../proxy/schema";
import { getMcpAuthContext } from "agents/mcp/server";

const claimSchema = z.object({
  id: z.string().optional(),
  service: z.string().optional(),
  action: z.string().optional(),
  target: z.string(),
  detail: z.string().optional(),
  repo: z.string().optional(),
});

export async function createLifeDiffServer(env: Env, fetchImpl: typeof fetch = fetch): Promise<McpServer> {
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
      description: "Diff GitHub against the session snapshot and write a receipt. Logged actions are claims. Life Diff stays read-only.",
      inputSchema: z.object({
        sessionId: z.string().optional(),
        timeZone: z.string().optional(),
        claims: z.array(claimSchema).optional(),
        includeHtml: z.boolean().optional(),
      }),
    },
    async (input) => run(async () => {
      const deps = await appDeps(env, user());
      const result = await endSession(deps, {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        ...(input.claims ? { claims: input.claims as ClaimInput[] } : {}),
      });
      const payload = {
        summary: result.summary,
        receipt: result.receipt,
        htmlUrl: `/receipts/${result.receipt.id}`,
        ...(input.includeHtml ? { html: result.html } : {}),
      };
      return text(`${result.summary}\n\nReceipt ${result.receipt.id}`, payload);
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
        htmlUrl: `/receipts/${result.receipt.id}`,
        ...(input.includeHtml ? { html: result.html } : {}),
      };
      return text(`Receipt ${result.receipt.id}`, payload);
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
  registerUpstreamAdmin(server, env);
  try {
    await registerForwardedTools(server, env, fetchImpl);
  } catch (error) {
    console.error("upstream registration skipped", error instanceof Error ? error.name : "error");
  }
  return server;
}

function registerUpstreamAdmin(server: McpServer, env: Env): void {
  server.registerTool(
    "add_upstream",
    {
      description: "Register an MCP server. Life Diff forwards its tools and records every call. The token is stored encrypted and is never returned.",
      inputSchema: z.object({
        name: z.string(),
        url: z.string(),
        token: z.string().optional(),
      }),
    },
    async (input) => run(async () => {
      const who = user();
      const saved = await addUpstream(coreDeps(env, who).meta, env.TOKEN_ENCRYPTION_KEY, who.userId, new Date(), input);
      return text(`Registered ${saved.name}. Reconnect the MCP client so its tools appear.`, saved);
    }),
  );
  server.registerTool(
    "list_upstreams",
    {
      description: "List MCP servers registered for this Life Diff account. Tokens are not included.",
      inputSchema: z.object({}),
    },
    async () => run(async () => {
      const who = user();
      const upstreams = await listUpstreamPublic(coreDeps(env, who).meta, who.userId);
      return text(upstreams.map((item) => `${item.name} ${item.url}`).join("\n") || "No upstream servers yet.", { upstreams });
    }),
  );
  server.registerTool(
    "remove_upstream",
    {
      description: "Remove a registered MCP server by name. This does not call the upstream.",
      inputSchema: z.object({ name: z.string() }),
    },
    async (input) => run(async () => {
      const who = user();
      await removeUpstream(coreDeps(env, who).meta, who.userId, input.name);
      return text(`Removed ${input.name.trim().toLowerCase()}.`, { removed: input.name.trim().toLowerCase() });
    }),
  );
}

async function registerForwardedTools(server: McpServer, env: Env, fetchImpl: typeof fetch): Promise<void> {
  const who = user();
  const secrets = await loadUpstreamSecrets(coreDeps(env, who).meta, env.TOKEN_ENCRYPTION_KEY, who.userId);
  for (const secret of secrets) {
    if (secret.tokenUnreadable) continue;
    const target: UpstreamTarget = {
      name: secret.name,
      url: secret.url,
      ...(secret.token ? { token: secret.token } : {}),
    };
    let tools: ListedTool[] = [];
    try {
      tools = await listUpstreamTools(target, fetchImpl);
    } catch (error) {
      console.error("upstream list failed", secret.name, error instanceof Error ? error.name : "error");
      continue;
    }
    for (const tool of tools) {
      const exposed = namespacedTool(secret.name, tool.name);
      if (!exposed) continue;
      const annotations = annotationsFor(tool.annotations);
      try {
        server.registerTool(
          exposed,
          {
            description: `${tool.description ?? `Call ${tool.name}.`}\n\nForwarded by Life Diff and recorded on the receipt.`,
            inputSchema: jsonSchema(tool.inputSchema),
            ...(annotations ? { annotations } : {}),
          },
          async (args: unknown) => {
            const call = await callUpstreamTool(target, tool.name, args, fetchImpl);
            try {
              await recordProxyCall(coreDeps(env, who), {
                upstream: secret.name,
                tool: tool.name,
                args,
                ok: call.ok,
                durationMs: call.durationMs,
                resultSummary: call.resultSummary,
                ...(call.error ? { error: call.error } : {}),
              });
            } catch (error) {
              console.error("action log failed", error instanceof Error ? error.name : "error");
            }
            return {
              content: call.content,
              ...(call.isError ? { isError: true as const } : {}),
              ...(call.structuredContent ? { structuredContent: call.structuredContent } : {}),
            };
          },
        );
      } catch (error) {
        console.error("skipped tool", exposed, error instanceof Error ? error.name : "error");
      }
    }
  }
}

function annotationsFor(raw: Record<string, unknown> | undefined): ToolAnnotations | undefined {
  if (!raw) return undefined;
  const annotations: ToolAnnotations = {};
  if (typeof raw.readOnlyHint === "boolean") annotations.readOnlyHint = raw.readOnlyHint;
  if (typeof raw.destructiveHint === "boolean") annotations.destructiveHint = raw.destructiveHint;
  if (typeof raw.idempotentHint === "boolean") annotations.idempotentHint = raw.idempotentHint;
  if (typeof raw.openWorldHint === "boolean") annotations.openWorldHint = raw.openWorldHint;
  if (typeof raw.title === "string") annotations.title = raw.title;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
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
