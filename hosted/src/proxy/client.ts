import { HOSTED_VERSION } from "../constants";

const PROTOCOL = "2025-03-26";
const MAX_BODY = 1_500_000;

export interface UpstreamAuth {
  header: string;
  value: string;
}

export interface UpstreamTarget {
  name: string;
  url: string;
  auth?: UpstreamAuth;
}

export interface UpstreamToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

interface RpcMessage {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

export async function listUpstreamTools(fetchImpl: typeof fetch, target: UpstreamTarget, timeoutMs = 15_000): Promise<UpstreamToolInfo[]> {
  const session = await openSession(fetchImpl, target, timeoutMs);
  const tools: UpstreamToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = await rpc(fetchImpl, target, session, "tools/list", cursor ? { cursor } : {}, timeoutMs);
    const record = asRecord(result);
    const listed = Array.isArray(record?.tools) ? record.tools : [];
    for (const item of listed) {
      const tool = asRecord(item);
      if (!tool || typeof tool.name !== "string" || !tool.name.trim()) continue;
      tools.push({
        name: tool.name,
        ...(typeof tool.title === "string" ? { title: tool.title } : {}),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
          ? { inputSchema: tool.inputSchema as Record<string, unknown> }
          : {}),
      });
    }
    const next = typeof record?.nextCursor === "string" ? record.nextCursor : "";
    if (!next) break;
    cursor = next;
  }
  return tools;
}

export async function callUpstreamTool(
  fetchImpl: typeof fetch,
  target: UpstreamTarget,
  tool: string,
  args: unknown,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const session = await openSession(fetchImpl, target, timeoutMs);
  const result = await rpc(fetchImpl, target, session, "tools/call", {
    name: tool,
    arguments: args && typeof args === "object" ? args : {},
  }, timeoutMs);
  const record = asRecord(result);
  if (!record) return { content: [{ type: "text", text: "The upstream returned an empty result." }] };
  return record;
}

interface Session {
  id?: string;
  protocol: string;
}

async function openSession(fetchImpl: typeof fetch, target: UpstreamTarget, timeoutMs: number): Promise<Session> {
  const opened = await post(fetchImpl, target, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "lifediff", version: HOSTED_VERSION },
    },
  }, undefined, timeoutMs);
  const result = asRecord(opened.result);
  const protocol = typeof result?.protocolVersion === "string" ? result.protocolVersion : PROTOCOL;
  const session: Session = { protocol, ...(opened.sessionId ? { id: opened.sessionId } : {}) };
  try {
    await post(fetchImpl, target, { jsonrpc: "2.0", method: "notifications/initialized" }, session, timeoutMs);
  } catch {
    // A server can refuse the notification and still accept tools/list and tools/call.
  }
  return session;
}

async function rpc(
  fetchImpl: typeof fetch,
  target: UpstreamTarget,
  session: Session,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const response = await post(fetchImpl, target, { jsonrpc: "2.0", id: 2, method, params }, session, timeoutMs);
  return response.result;
}

async function post(
  fetchImpl: typeof fetch,
  target: UpstreamTarget,
  message: Record<string, unknown>,
  session: Session | undefined,
  timeoutMs: number,
): Promise<{ result: unknown; sessionId?: string }> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (session?.protocol) headers.set("mcp-protocol-version", session.protocol);
  if (session?.id) headers.set("mcp-session-id", session.id);
  if (target.auth?.header && target.auth.value) headers.set(target.auth.header, target.auth.value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(target.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new UpstreamError(`${target.name} did not respond in time.`);
      }
      throw new UpstreamError(`${target.name} could not be reached.`);
    }
    if (response.status === 202 || response.status === 204) {
      return { result: null, ...(response.headers.get("mcp-session-id") ? { sessionId: response.headers.get("mcp-session-id") ?? undefined } : {}) };
    }
    const text = await readLimited(response);
    if (!response.ok) throw new UpstreamError(`${target.name} returned HTTP ${response.status}.`);
    if (message.id === undefined) {
      return { result: null, ...(headerSession(response) ? { sessionId: headerSession(response) } : {}) };
    }
    const parsed = parseRpc(text, response.headers.get("content-type") ?? "");
    const matched = matchId(parsed, message.id);
    if (!matched) throw new UpstreamError(`${target.name} sent a response Life Diff could not read.`);
    if (matched.error) {
      const raw = typeof matched.error.message === "string" ? matched.error.message : `${target.name} rejected the call.`;
      throw new UpstreamError(raw.slice(0, 500));
    }
    return { result: matched.result, ...(headerSession(response) ? { sessionId: headerSession(response) } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

function headerSession(response: Response): string | undefined {
  return response.headers.get("mcp-session-id") ?? undefined;
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    if (!step.value) continue;
    total += step.value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel();
      throw new UpstreamError("The upstream response was too large to record.");
    }
    chunks.push(step.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function parseRpc(text: string, contentType: string): RpcMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const sse = contentType.includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.startsWith("data:");
  const values = sse ? parseSse(trimmed) : [parseJson(trimmed)];
  return values.flatMap((value) => {
    const record = asRecord(value);
    return record ? [record as RpcMessage] : [];
  });
}

export function parseSse(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      messages.push(JSON.parse(data) as unknown);
    } catch {
      // Ignore keepalive comments and non-JSON events.
    }
  }
  return messages;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function matchId(messages: RpcMessage[], id: unknown): RpcMessage | undefined {
  return messages.find((message) => message.id === id)
    ?? messages.find((message) => message.result !== undefined || message.error !== undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
