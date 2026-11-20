import { HOSTED_VERSION } from "../constants";
import { clip } from "../text";
import { redactText } from "./redact";

const PROTOCOL = "2025-06-18";
const MAX_TOOLS = 40;
const MAX_BODY = 1_000_000;

export interface UpstreamTarget {
  name: string;
  url: string;
  token?: string;
}

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface UpstreamCall {
  ok: boolean;
  isError: boolean;
  durationMs: number;
  error?: string;
  resultSummary: string;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
}

export async function listUpstreamTools(upstream: UpstreamTarget, fetchImpl: typeof fetch = fetch): Promise<ListedTool[]> {
  const session = await openSession(upstream, fetchImpl);
  const rpc = await rpcCall(upstream, "tools/list", {}, session, fetchImpl);
  if (rpc.error) throw new Error(rpc.error);
  const tools = toolsFromResult(rpc.result);
  return tools.slice(0, MAX_TOOLS);
}

export async function callUpstreamTool(
  upstream: UpstreamTarget,
  tool: string,
  args: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamCall> {
  const started = Date.now();
  try {
    const session = await openSession(upstream, fetchImpl);
    const rpc = await rpcCall(upstream, "tools/call", {
      name: tool,
      arguments: args && typeof args === "object" ? args : {},
    }, session, fetchImpl);
    const durationMs = Date.now() - started;
    if (rpc.error) return failed(durationMs, rpc.error);
    return succeeded(durationMs, rpc.result);
  } catch (error) {
    const message = safeError(error);
    return failed(Date.now() - started, message);
  }
}

async function openSession(upstream: UpstreamTarget, fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const init = await rpcCall(upstream, "initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "lifediff", version: HOSTED_VERSION },
    }, undefined, fetchImpl);
    if (init.sessionId) await notifyInitialized(upstream, init.sessionId, fetchImpl);
    return init.sessionId;
  } catch {
    return undefined;
  }
}

async function notifyInitialized(upstream: UpstreamTarget, sessionId: string, fetchImpl: typeof fetch): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetchImpl(upstream.url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        ...baseHeaders(upstream),
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  } catch {
    // A missing notification must not hide the tool result.
  } finally {
    clearTimeout(timer);
  }
}

interface RpcOutcome {
  result?: unknown;
  error?: string;
  sessionId?: string;
}

async function rpcCall(
  upstream: UpstreamTarget,
  method: string,
  params: unknown,
  sessionId: string | undefined,
  fetchImpl: typeof fetch,
): Promise<RpcOutcome> {
  assertPublicUrl(upstream.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const headers = baseHeaders(upstream);
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await fetchImpl(upstream.url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (response.status >= 300 && response.status < 400) {
      return { error: "The upstream redirected. Life Diff did not follow it." };
    }
    if (!response.ok) {
      return { error: `The upstream returned HTTP ${response.status}.` };
    }
    const text = await response.text();
    if (text.length > MAX_BODY) return { error: "The upstream response was too large to record." };
    const message = pickMessage(response.headers.get("content-type") ?? "", text);
    if (!message) return { error: "The upstream response was not JSON-RPC." };
    const nextSession = response.headers.get("mcp-session-id") ?? sessionId;
    if (message.error) {
      const record = message.error as { message?: unknown };
      const reason = typeof record.message === "string" ? record.message : "The upstream rejected the call.";
      return { error: clip(redactText(reason), 400), ...(nextSession ? { sessionId: nextSession } : {}) };
    }
    return { result: message.result, ...(nextSession ? { sessionId: nextSession } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

function baseHeaders(upstream: UpstreamTarget): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL,
    ...authHeaders(upstream.token),
  };
}

export function authHeaders(token: string | undefined): Record<string, string> {
  if (!token?.trim()) return {};
  const trimmed = token.trim();
  const custom = /^([A-Za-z0-9-]{1,40}):\s*(\S[\s\S]*)$/.exec(trimmed);
  if (custom?.[1] && custom[2]) {
    const name = custom[1];
    const value = custom[2].trim();
    if (name.toLowerCase() === "authorization") {
      const cleaned = cleanHeader(value);
      return { authorization: /^bearer\s+/i.test(cleaned) ? cleaned : `Bearer ${cleaned}` };
    }
    if (!blockedHeader(name)) return { [name]: cleanHeader(value) };
  }
  const cleaned = cleanHeader(trimmed);
  const value = /^bearer\s+/i.test(cleaned) ? cleaned : `Bearer ${cleaned}`;
  return { authorization: value };
}

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]/g, "").trim();
}

function blockedHeader(name: string): boolean {
  const folded = name.toLowerCase();
  return folded === "host" || folded === "content-type" || folded === "content-length" || folded === "cookie";
}

function assertPublicUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Upstream URL is not valid.");
  }
  if (url.username || url.password) throw new Error("Upstream URL must not contain a secret.");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && loopback) return;
  if (url.protocol !== "https:") throw new Error("Upstream URL must be https.");
}

function pickMessage(contentType: string, text: string): { result?: unknown; error?: unknown } | null {
  const messages = contentType.includes("text/event-stream") || text.includes("\ndata:") || text.startsWith("data:")
    ? parseSse(text)
    : parseJson(text);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && (message.result !== undefined || message.error !== undefined)) return message;
  }
  return null;
}

function parseJson(text: string): { result?: unknown; error?: unknown }[] {
  try {
    const parsed = JSON.parse(text) as { result?: unknown; error?: unknown };
    return parsed && typeof parsed === "object" ? [parsed] : [];
  } catch {
    return [];
  }
}

function parseSse(text: string): { result?: unknown; error?: unknown }[] {
  const messages: { result?: unknown; error?: unknown }[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { result?: unknown; error?: unknown };
      if (parsed && typeof parsed === "object") messages.push(parsed);
    } catch {
      // Ignore a non-JSON event.
    }
  }
  return messages;
}

function toolsFromResult(result: unknown): ListedTool[] {
  if (!result || typeof result !== "object") throw new Error("Upstream did not return a tool list.");
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) throw new Error("Upstream did not return a tool list.");
  const listed: ListedTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const record = tool as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown };
    if (typeof record.name !== "string" || !record.name.trim()) continue;
    listed.push({
      name: record.name,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(record.inputSchema && typeof record.inputSchema === "object" ? { inputSchema: record.inputSchema as Record<string, unknown> } : {}),
      ...(record.annotations && typeof record.annotations === "object" ? { annotations: record.annotations as Record<string, unknown> } : {}),
    });
  }
  return listed;
}

function succeeded(durationMs: number, result: unknown): UpstreamCall {
  const record = result && typeof result === "object" ? result as { content?: unknown; isError?: unknown; structuredContent?: unknown } : {};
  const isError = record.isError === true;
  const text = textFromContent(record.content) || (isError ? "The tool reported an error." : "The tool finished.");
  const summary = clip(redactText(text), 400);
  const structured = record.structuredContent && typeof record.structuredContent === "object" && !Array.isArray(record.structuredContent)
    ? record.structuredContent as Record<string, unknown>
    : undefined;
  return {
    ok: !isError,
    isError,
    durationMs,
    resultSummary: summary,
    content: [{ type: "text", text: clip(text, 8000) }],
    ...(isError ? { error: summary } : {}),
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) parts.push(text.trim());
  }
  return parts.join("\n");
}

function failed(durationMs: number, message: string): UpstreamCall {
  const summary = clip(redactText(message), 400);
  return {
    ok: false,
    isError: true,
    durationMs,
    error: summary,
    resultSummary: summary,
    content: [{ type: "text", text: summary }],
  };
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "The upstream did not answer in time.";
  if (error instanceof Error && error.message && !/bearer\s+\S+/i.test(error.message)) return clip(error.message, 400);
  return "The upstream call failed.";
}
