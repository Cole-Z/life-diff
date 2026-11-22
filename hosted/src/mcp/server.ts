import { HOSTED_VERSION, SCOPES } from "../constants";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appDeps, coreDeps } from "../app/runtime";
import { ACTION_VALUES } from "../actions/log";
import { endSession, getReceipt, listReceipts, logAction, requestUndo, startSession, AppError } from "../app/service";
import type { Env } from "../env";
import { clientName } from "./client-name";
import { invalidateUpstreamCache, registerUpstreamTools, upstreamDiscoveryNotice } from "./upstream-tools";
import { approvedUpstreamEndpoints } from "../proxy/namespace";
import { addUpstream, listPublicUpstreams, removeUpstream } from "../proxy/upstreams";
import { D1MetadataStore } from "../storage/d1";
import type { ClaimInput } from "../receipt/types";
import type { GitHubApi } from "../github/types";
import { getMcpAuthContext } from "agents/mcp/server";
import { redactText } from "../proxy/redact";
import { signViewGrant, viewUrl } from "../crypto/view-token";
import { buildRoundup, pngContent, receiptPresentation, sessionToolPayload, summaryFor, undoEntries } from "../receipt/roundup";

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
  "Life Diff makes session receipts and a daily roundup from calls routed through it and changes the agent reports. GitHub signs users in. Repository checks are optional. Each GitHub account shares one open session across clients.",
  "Use namespaced tools (<upstream>__<tool>) for calls the user wants routed through Life Diff. After registering an upstream, refresh discovery. A captured call includes a session ID. If capture fails, report that separately from the upstream outcome. Check upstream state before repeating a possible write.",
  "Use end_session with the recorded session ID when the user wants the receipt now. The idle preference sets eligibility for the next session-opening activity or scheduled sweep.",
  "Call log_action for changes made outside the proxy. Use get_daily_diff for the local calendar day, including open activity still in progress. Show Markdown when the client skips MCP images.",
  "Pass repos to start_session only for repositories the user explicitly named for verification.",
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
      description: "Open or reuse the account’s shared Life Diff session. A captured call can also open a session. A stale session can close on this call or the scheduled sweep. Pass repos only for GitHub repositories the user explicitly asked to include. With no repos, Life Diff records tool calls and does not read GitHub.",
      inputSchema: z.object({
        repos: z.array(z.string()).max(25).optional(),
        timeZone: z.string().optional(),
        agentName: z.string().optional(),
      }),
    },
    async (input, ctx) => run(async () => {
      const who = user();
      const deps = input.repos && input.repos.length > 0 ? await appDeps(env, who) : { ...coreDeps(env, who), github: idleGithub() };
      const agentName = input.agentName?.trim() || clientName(server, ctx);
      const result = await startSession(deps, { ...input, ...(agentName ? { agentName } : {}) });
      const named = result.repos.length > 0 ? `GitHub: ${result.repos.join(", ")}.` : "GitHub history is off for this session.";
      return text(`Session ${result.sessionId}. ${named}`, result);
    }),
  );
  server.registerTool(
    "log_action",
    {
      description: "Record a change made outside Life Diff. Do not use this for a read, or for a tool already called through Life Diff. action is added, removed, modified, moved, shared, or read. move and rename are moved. share is shared. trash is removed. Optional before and after are the old and new values, such as a moved event's times. Optional url is an https link to the object. Life Diff does not run the tool. A GitHub change is checked only when this session snapshotted GitHub. Anything else is shown as what the agent said.",
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
      description: "Close the open session and return the receipt. Omit sessionId to close the current session. If that session, or the most recent one, was already closed in the last day, the saved receipt is returned. Show the markdown only when something changed. When nothing changed, the result is one short line and no card, and imageUrl and cardToken are omitted. get_receipt still returns the card. Rely on get_daily_diff instead of an empty receipt. Optional claims may include before, after, and url.",
      inputSchema: z.object({
        sessionId: z.string().optional(),
        timeZone: z.string().optional(),
        claims: z.array(claimSchema).optional(),
        includeHtml: z.boolean().optional(),
        agentName: z.string().optional(),
      }),
    },
    async (input, ctx) => run(async () => {
      const who = user();
      const now = new Date();
      const core = coreDeps(env, who, now);
      const versions = await core.meta.getAccessVersions(who.userId);
      const open = await core.sessions.getOpen();
      const deps = open?.snapshotKey ? await appDeps(env, who, now) : { ...core, github: idleGithub() };
      const agentName = input.agentName?.trim() || clientName(server, ctx);
      const result = await endSession(deps, {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        ...(input.claims ? { claims: input.claims as ClaimInput[] } : {}),
        ...(agentName ? { agentName } : {}),
      });
      const link = receiptUrl(env, result.receipt.id);
      const shown = await receiptPresentation(core, result.receipt, link);
      const token = await signedViewToken(env, "receipt", result.receipt.id, who.userId, versions?.historyVersion);
      const signed = token ? viewUrl(env.ISSUER, "receipt", result.receipt.id, token) : undefined;
      const payload = sessionToolPayload({
        summary: summaryFor(result.receipt),
        receipt: result.receipt,
        markdown: shown.markdown,
        url: link,
        quiet: shown.quiet,
        ...(shown.imageUrl ? { imageUrl: shown.imageUrl } : {}),
        ...(signed ? { viewUrl: signed } : {}),
        ...(input.includeHtml ? { html: result.html, includeHtml: true } : {}),
      });
      return shownContent(shown.markdown, shown.quiet ? new Uint8Array() : shown.png, payload);
    }),
  );
  server.registerTool(
    "undo_change",
    {
      description: "Return the plain-English undo instruction for one change on a receipt, plus the original tool and arguments when they were stored. Life Diff does not run the undo. Run the suggested call yourself. This records that an undo was requested. It does not mean the undo happened. The next receipt shows the reverse change only after you run it.",
      inputSchema: z.object({
        receiptId: z.string(),
        changeId: z.string(),
      }),
    },
    async (input) => run(async () => {
      const result = await requestUndo(coreDeps(env, user()), { ...input, origin: env.ISSUER });
      const first = result.undos[0];
      return text(first?.prompt ?? "Nothing to undo.", result);
    }),
  );
  server.registerTool(
    "undo_session",
    {
      description: "Return an undo instruction for every change on a receipt. Life Diff does not run them. Run each suggested call yourself. This records that an undo was requested. It does not mean any undo happened.",
      inputSchema: z.object({ receiptId: z.string() }),
    },
    async (input) => run(async () => {
      const result = await requestUndo(coreDeps(env, user()), { ...input, origin: env.ISSUER });
      const textBody = result.undos.map((item) => item.prompt).join("\n");
      return text(textBody || "Nothing to undo.", result);
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
      const versions = await deps.meta.getAccessVersions(who.userId);
      const result = await getReceipt(deps, input.receiptId);
      const link = receiptUrl(env, result.receipt.id);
      const shown = await receiptPresentation(deps, result.receipt, link);
      const token = await signedViewToken(env, "receipt", result.receipt.id, who.userId, versions?.historyVersion);
      const signed = token ? viewUrl(env.ISSUER, "receipt", result.receipt.id, token) : undefined;
      const payload = {
        summary: summaryFor(result.receipt),
        receipt: result.receipt,
        markdown: shown.markdown,
        url: link,
        htmlUrl: signed ?? link,
        ...(signed ? { viewUrl: signed } : {}),
        ...(shown.imageUrl ? { imageUrl: shown.imageUrl } : {}),
        ...(input.includeHtml ? { html: result.html } : {}),
        undos: undoEntries(shown.lines, link),
      };
      return shownContent(shown.markdown, shown.png, payload);
    }),
  );
  const daily = dailyHandler(env);
  server.registerTool(
    "get_daily_diff",
    {
      description: "Today's diff across every session and agent: what changed, what failed, and how many lookups. Defaults to the user's local day. Pass date (YYYY-MM-DD) for another day, since last_viewed for lines since the last time this was opened, or detail true to list each lookup. An open session is included as in progress and is not closed. When nothing changed, this is one short line and no card. Show the markdown to the user. Rely on this at the end of the day instead of an empty receipt.",
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
      description: "Register an approved MCP endpoint so its tools are called through Life Diff and recorded. Tools are named <name>__<tool>. The token is stored encrypted and is not returned. Reconnect if the client cached the tool list.",
      inputSchema: z.object({
        name: z.string(),
        url: z.string(),
        token: z.string().optional(),
        header: z.string().optional(),
      }),
    },
    async (input) => run(async () => {
      const who = user();
      const added = await addUpstream(new D1MetadataStore(env.DB), who.userId, env.TOKEN_ENCRYPTION_KEY, new Date(), approvedUpstreamEndpoints(env), input);
      invalidateUpstreamCache(who.userId);
      try { server.sendToolListChanged(); } catch { /* stateless clients need to reconnect */ }
      return text(`Registered ${added.name} for discovery. Refresh or reconnect and look for ${added.name}__<tool>. If none appear, check the endpoint and credentials and try discovery again.`, { upstream: added, discoveryStatus: "pending", reconnect: true });
    }),
  );
  server.registerTool(
    "list_upstreams",
    {
      description: "List MCP servers registered for this Life Diff account. This lists saved connections. Confirm discovery in the client tool catalog.",
      inputSchema: z.object({}),
    },
    async () => run(async () => {
      const who = user();
      const saved = await listPublicUpstreams(new D1MetadataStore(env.DB), who.userId, approvedUpstreamEndpoints(env));
      const upstreams = saved.map((item) => {
        const discoveryNotice = item.status === "approved" ? upstreamDiscoveryNotice(who.userId, item) : undefined;
        return discoveryNotice ? { ...item, discoveryNotice } : item;
      });
      const lines = upstreams.map((item) => {
        if (item.status === "blocked") return `${item.name} (blocked by the endpoint policy)`;
        const notice = "discoveryNotice" in item ? ` · ${item.discoveryNotice}` : "";
        return `${item.name} ${item.url}${notice}`;
      });
      return text(lines.join("\n") || "No upstreams yet.", { upstreams });
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
    const versions = await deps.meta.getAccessVersions(who.userId);
    const roundup = await buildRoundup(
      { ...deps, issuer: env.ISSUER },
      {
        save: true,
        markViewed: true,
        ...(input.date ? { date: input.date } : {}),
        ...(input.detail ? { detail: true } : {}),
        ...(input.since ? { since: input.since } : {}),
      },
    );
    const origin = env.ISSUER.replace(/\/$/, "");
    const token = await signedViewToken(env, "day", roundup.day, who.userId, versions?.historyVersion);
    return shownContent(roundup.markdown, roundup.quiet ? new Uint8Array() : roundup.png, {
      day: roundup.day,
      since: roundup.since,
      url: `${origin}/roundup/${roundup.day}`,
      ...(token ? { viewUrl: viewUrl(origin, "day", roundup.day, token) } : {}),
      ...(token && roundup.cardToken ? { imageUrl: `${origin}/roundup/card.png?t=${encodeURIComponent(token)}` } : {}),
      lines: roundup.lines.map((line) => ({
        service: line.service,
        source: line.source,
        summary: redactText(line.summary),
        tone: line.tone,
        ...(line.trust ? { trust: line.trust } : {}),
        ...(line.id ? { id: line.id } : {}),
        ...(line.undo ? { undoPrompt: line.undo } : {}),
        ...(line.id && line.undo ? { changeId: line.id } : {}),
        ...(line.undoDaysLeft ? { undoDaysLeft: line.undoDaysLeft } : {}),
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

async function signedViewToken(env: Env, kind: "receipt" | "day", id: string, userId: string, historyVersion: string | undefined): Promise<string | undefined> {
  const key = env.COOKIE_SIGNING_KEY ?? "";
  if (key.trim().length < 32 || historyVersion === undefined) return undefined;
  try {
    return await signViewGrant(key, { kind, id, userId, historyVersion }, Math.floor(Date.now() / 1000));
  } catch {
    return undefined;
  }
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
