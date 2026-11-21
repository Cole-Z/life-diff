import { HOSTED_VERSION, SCOPES } from "../constants";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appDeps, coreDeps, sessionStub } from "../app/runtime";
import { ACTION_VALUES } from "../actions/log";
import { clearHistory, endSession, getReceipt, listReceipts, logAction, sealOpenSession, startSession, AppError } from "../app/service";
import type { Env } from "../env";
import { clientName } from "./client-name";
import { invalidateUpstreamCache, registerUpstreamTools } from "./upstream-tools";
import { addUpstream, listPublicUpstreams, removeUpstream } from "../proxy/upstreams";
import { D1MetadataStore } from "../storage/d1";
import type { ClaimInput } from "../receipt/types";
import type { GitHubApi } from "../github/types";
import { getMcpAuthContext } from "agents/mcp/server";
import { redactText } from "../proxy/redact";
import { buildRoundup, pngContent, receiptPresentation, sessionToolPayload } from "../receipt/roundup";

const claimSchema = z.object({
  id: z.string().optional(),
  service: z.string().optional(),
  action: z.string().optional(),
  target: z.string(),
  detail: z.string().optional(),
  repo: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  url: z.string().optional(),
});

const INSTRUCTIONS = [
  "Life Diff is a daily diff of what your AI agents changed across the tools you use. It is not a GitHub diff. GitHub is only how the user signs in.",
  "Route the user's other tool calls through this server. After an upstream is added, its tools are named <upstream>__<tool>. A session starts on the first call if none is open. The proxied result includes that session id. Call end_session before your final reply. Omit sessionId and end_session closes the open session. An idle session closes itself after the quiet period (20 minutes unless the user changed it).",
  "Call log_action only for a change made outside Life Diff. Skip reads. Show the receipt only when something changed. When nothing changed, rely on get_daily_diff instead of pasting an empty receipt.",
  "Call get_daily_diff at the end of the day (get_roundup is the same tool) and show that markdown to the user. The day follows the user's time zone. When nothing changed, that result is one short line and no card.",
  "Pass repos to start_session only for repositories the user explicitly named. Do not treat a missing list item as a deletion. A failed call is a failure, not a read.",
].join(" ");

const dailySchema = z.object({
  date: z.string().optional(),
  detail: z.boolean().optional(),
  since: z.string().optional(),
});

export async function createLifeDiffServer(env: Env): Promise<McpServer> {
  const server = new McpServer({ name: "lifediff", version: HOSTED_VERSION }, { instructions: INSTRUCTIONS });
  server.registerTool(
    "start_session",
    {
      description: "Open a Life Diff session. A session also starts on the first proxied call, and an idle one closes itself. Pass repos only for GitHub repositories the user explicitly asked to include. With no repos, Life Diff records tool calls and does not read GitHub.",
      inputSchema: z.object({
        repos: z.array(z.string()).max(25).optional(),
        timeZone: z.string().optional(),
      }),
    },
    async (input) => run(async () => {
      const who = user();
      const deps = input.repos && input.repos.length > 0 ? await appDeps(env, who) : { ...coreDeps(env, who), github: idleGithub() };
      const result = await startSession(deps, input);
      const named = result.repos.length > 0 ? `GitHub: ${result.repos.join(", ")}.` : "GitHub history is off for this session.";
      return text(`Session ${result.sessionId}. ${named}`, result);
    }),
  );
  server.registerTool(
    "log_action",
    {
      description: "Record a change made outside Life Diff. Do not use this for a read, or for a tool already called through Life Diff. action is added, removed, modified, or read. Optional before and after are the old and new values, such as a moved event's times. Optional url is an https link to the object. Life Diff does not run the tool. A GitHub change is checked only when this session snapshotted GitHub. Anything else is shown as reported, not verified.",
      inputSchema: z.object({
        sessionId: z.string().optional(),
        tool: z.string(),
        action: z.enum(ACTION_VALUES).optional(),
        target: z.string(),
        detail: z.string().optional(),
        resource: z.string().optional(),
        repo: z.string().optional(),
        before: z.string().optional(),
        after: z.string().optional(),
        url: z.string().optional(),
      }),
    },
    async (input, ctx) => run(async () => {
      const logged = await logAction(coreDeps(env, user()), { ...input, ...(clientName(server, ctx) ? { client: clientName(server, ctx) } : {}) });
      return text("Logged.", logged);
    }),
  );
  server.registerTool(
    "end_session",
    {
      description: "Close the open session and return the receipt. Omit sessionId to close the current session. Show the markdown only when something changed. When nothing changed, the result is one short line and no card, and imageUrl and cardToken are omitted. get_receipt still returns the card. Rely on get_daily_diff instead of an empty receipt. Optional claims may include before, after, and url.",
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
      const link = receiptUrl(env, result.receipt.id);
      const shown = await receiptPresentation(core, result.receipt, link);
      const payload = sessionToolPayload({
        summary: result.summary,
        receipt: result.receipt,
        markdown: shown.markdown,
        url: link,
        quiet: shown.quiet,
        ...(shown.imageUrl ? { imageUrl: shown.imageUrl } : {}),
        ...(input.includeHtml ? { html: result.html, includeHtml: true } : {}),
      });
      return shownContent(shown.markdown, shown.quiet ? new Uint8Array() : shown.png, payload);
    }),
  );
  server.registerTool(
    "get_receipt",
    {
      description: "Read one saved Life Diff receipt by id, including its card. Show the returned markdown to the user.",
      inputSchema: z.object({
        receiptId: z.string(),
        includeHtml: z.boolean().optional(),
      }),
    },
    async (input) => run(async () => {
      const who = user();
      const deps = coreDeps(env, who);
      const result = await getReceipt(deps, input.receiptId);
      const link = receiptUrl(env, result.receipt.id);
      const shown = await receiptPresentation(deps, result.receipt, link);
      const payload = {
        summary: result.receipt.counts,
        receipt: result.receipt,
        markdown: shown.markdown,
        url: link,
        htmlUrl: link,
        ...(shown.imageUrl ? { imageUrl: shown.imageUrl } : {}),
        ...(input.includeHtml ? { html: result.html } : {}),
      };
      return shownContent(shown.markdown, shown.png, payload);
    }),
  );
  const daily = dailyHandler(env);
  server.registerTool(
    "get_daily_diff",
    {
      description: "Today's diff across every session and agent: what changed, what failed, and how many lookups. Defaults to the user's local day. Pass date (YYYY-MM-DD) for another day, since last_viewed for lines since the last time this was opened, or detail true to list each lookup. When nothing changed, this is one short line and no card. Show the markdown to the user. Rely on this at the end of the day instead of an empty receipt.",
      inputSchema: dailySchema,
    },
    daily,
  );
  server.registerTool(
    "get_roundup",
    {
      description: "Same as get_daily_diff. Today's diff across every session and agent. Show the markdown to the user at the end of the day.",
      inputSchema: dailySchema,
    },
    daily,
  );
  server.registerTool(
    "list_receipts",
    {
      description: "List saved Life Diff receipts for the signed-in user, newest first.",
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
      description: "Register an MCP server so its tools are called through Life Diff and recorded. Tools are named <name>__<tool>. The token is stored encrypted and is not returned. Reconnect if the client cached the tool list.",
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
      description: "List MCP servers registered for this Life Diff account. Tokens are not included.",
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
      description: "Remove a registered MCP server by name. Reconnect if the client still shows its tools.",
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
  server.registerTool(
    "clear_my_history",
    {
      description: "Delete this account's sessions, receipts, and daily diffs. Does not remove upstream servers or the GitHub sign-in. Requires confirm true.",
      inputSchema: z.object({ confirm: z.boolean() }),
    },
    async (input) => run(async () => {
      if (input.confirm !== true) throw new AppError("Pass confirm: true to delete your Life Diff history.");
      const who = user();
      await clearHistory(coreDeps(env, who), () => sessionStub(env, who.userId).wipe());
      return text("Your Life Diff history was deleted. Upstream servers and the GitHub sign-in are still there.", { deleted: true });
    }),
  );
  try {
    await registerUpstreamTools(server, env, user());
  } catch {
    // Built-in tools still answer when an upstream cannot be listed.
  }
  return server;
}

function dailyHandler(env: Env) {
  return async (input: { date?: string; detail?: boolean; since?: string }) => run(async () => {
    const who = user();
    const now = new Date();
    const deps = await depsForDaily(env, who, now);
    const roundup = await buildRoundup(
      { ...deps, issuer: env.ISSUER },
      {
        save: true,
        markViewed: true,
        seal: () => sealOpenSession(deps),
        ...(input.date ? { date: input.date } : {}),
        ...(input.detail ? { detail: true } : {}),
        ...(input.since ? { since: input.since } : {}),
      },
    );
    const origin = env.ISSUER.replace(/\/$/, "");
    return shownContent(roundup.markdown, roundup.quiet ? new Uint8Array() : roundup.png, {
      day: roundup.day,
      since: roundup.since,
      url: `${origin}/roundup/${roundup.day}`,
      ...(roundup.imageUrl ? { imageUrl: roundup.imageUrl } : {}),
      lines: roundup.lines.map((line) => ({
        service: line.service,
        source: line.source,
        summary: redactText(line.summary),
        tone: line.tone,
        ...(line.trust ? { trust: line.trust } : {}),
        ...(line.id ? { id: line.id } : {}),
        ...(line.undo ? { undoHint: line.undo } : {}),
      })),
    });
  });
}

async function depsForDaily(env: Env, who: { userId: string; login: string }, now: Date) {
  try {
    return await appDeps(env, who, now);
  } catch {
    return { ...coreDeps(env, who, now), github: idleGithub() };
  }
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

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };

async function run(work: () => Promise<{ content: ToolContent[]; structuredContent: Record<string, unknown> }>) {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof AppError || error instanceof Error ? error.message : "Life Diff failed";
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

function shownContent(markdown: string, png: Uint8Array, structured: unknown) {
  const image = pngContent(png);
  return {
    content: [
      { type: "text" as const, text: markdown },
      ...(image ? [image] : []),
    ],
    structuredContent: structured as Record<string, unknown>,
  };
}

function text(message: string, structured: unknown) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: structured as Record<string, unknown>,
  };
}
