import { HOSTED_VERSION, SCOPES } from "../constants";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appDeps, coreDeps } from "../app/runtime";
import { endSession, getReceipt, listReceipts, logAction, startSession } from "../app/service";
import { AppError } from "../app/service";
import type { Env } from "../env";
import type { ClaimInput } from "../receipt/types";
import { getMcpAuthContext } from "agents/mcp/server";

const claimSchema = z.object({
  id: z.string().optional(),
  service: z.string().optional(),
  action: z.string().optional(),
  target: z.string(),
  detail: z.string().optional(),
  repo: z.string().optional(),
});

export function createLifeDiffServer(env: Env): McpServer {
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
  return server;
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
