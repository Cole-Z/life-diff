import type { CoreDeps } from "../app/service";
import { recordProxyCall } from "../app/service";
import { classifyToolName, plainAction } from "./classify";
import { callUpstreamTool, UpstreamError, type UpstreamTarget } from "./client";
import { boundJson, pickSubject, redactSnippet, scrubSecrets } from "./redact";

export interface ToolReply {
  content: { type: "text"; text: string; _meta?: Record<string, unknown> }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export async function forwardToolCall(deps: CoreDeps, fetchImpl: typeof fetch, target: UpstreamTarget, tool: string, args: unknown, endpoints: ReadonlySet<string>, client?: string): Promise<ToolReply> {
  const started = Date.now();
  const classification = classifyToolName(tool);
  const secrets = target.auth?.value ? [target.auth.value] : [];
  try {
    const result = await callUpstreamTool(fetchImpl, target, tool, args, endpoints);
    const durationMs = Date.now() - started;
    const failure = toolFailure(result);
    const resultText = scrubSecrets(firstText(result), secrets);
    const summary = plainAction(target.name, classification, pickSubject(boundJson(args)), !failure.failed, tool);
    const storedError = failure.failed
      ? redactSnippet(scrubSecrets(failure.message || resultText || "The upstream reported an error.", secrets))
      : undefined;
    const sessionId = await recordSafe(deps, {
      upstream: target.name,
      tool,
      args,
      ok: !failure.failed,
      status: failure.failed ? "error" : "ok",
      summary,
      classification,
      durationMs,
      ...(!failure.failed && resultText ? { result: redactSnippet(resultText) } : {}),
      ...(storedError ? { error: storedError } : {}),
      ...(client ? { client } : {}),
    });
    return withCapture(replyFrom(result, target.name, tool, failure.failed), sessionId);
  } catch (error) {
    const durationMs = Date.now() - started;
    const message = scrubSecrets(error instanceof UpstreamError || error instanceof Error ? error.message : "The upstream call failed.", secrets);
    const summary = plainAction(target.name, classification, pickSubject(boundJson(args)), false, tool);
    const sessionId = await recordSafe(deps, {
      upstream: target.name,
      tool,
      args,
      ok: false,
      status: "error",
      summary,
      classification,
      durationMs,
      error: message,
      ...(client ? { client } : {}),
    });
    return withCapture({
      isError: true,
      content: [{ type: "text", text: message || `${target.name} failed.` }],
    }, sessionId);
  }
}

async function recordSafe(deps: CoreDeps, input: {
  upstream: string;
  tool: string;
  args: unknown;
  ok: boolean;
  status: string;
  summary: string;
  classification: ReturnType<typeof classifyToolName>;
  durationMs: number;
  result?: string;
  error?: string;
  client?: string;
}): Promise<string | undefined> {
  try {
    const logged = await recordProxyCall(deps, input);
    return logged.sessionId;
  } catch {
    // The agent still receives the upstream result when the log cannot be written.
    return undefined;
  }
}

function withCapture(reply: ToolReply, sessionId: string | undefined): ToolReply {
  if (!sessionId) {
    const text = "Life Diff could not record this call. The upstream result is shown above. If it may have changed anything, check the upstream before taking further action.";
    return {
      ...reply,
      content: [...reply.content, { type: "text", text, _meta: { captureStatus: "failed" } }],
      _meta: { ...(reply._meta ?? {}), captureStatus: "failed" },
    };
  }
  return {
    ...reply,
    content: [...reply.content, { type: "text", text: `Life Diff session ${sessionId}.`, _meta: { sessionId } }],
    _meta: { ...(reply._meta ?? {}), sessionId, captureStatus: "recorded" },
  };
}

function replyFrom(result: Record<string, unknown>, upstream: string, tool: string, failed: boolean): ToolReply {
  const content = Array.isArray(result.content)
    ? result.content.flatMap((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
      if (!record || record.type !== "text" || typeof record.text !== "string") return [];
      return [{ type: "text" as const, text: record.text }];
    })
    : [];
  const omitted = Array.isArray(result.content) && result.content.some((item) => item && typeof item === "object" && item.type !== "text");
  if (omitted) content.push({ type: "text", text: "Life Diff beta relays text and structured results. This upstream also returned non-text content that was omitted." });
  if (content.length === 0) content.push({ type: "text", text: failed ? `${upstream} reported an error for ${tool}.` : `${upstream} returned no text for ${tool}.` });
  const reply: ToolReply = { content };
  if (typeof result.isError === "boolean") reply.isError = result.isError;
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) {
    reply.structuredContent = result.structuredContent as Record<string, unknown>;
  }
  return reply;
}

/** A tool result that reports failure without throwing, including an obvious error payload. */
export function toolFailure(result: Record<string, unknown>): { failed: boolean; message?: string } {
  if (result.isError === true) return { failed: true, message: textOf(result.error) || firstText(result) || undefined };
  if (result.error !== undefined && result.error !== null && result.error !== false) {
    return { failed: true, message: textOf(result.error) || firstText(result) || undefined };
  }
  const text = firstText(result);
  if (obviousErrorText(text)) return { failed: true, message: text };
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const record = structured as Record<string, unknown>;
    if (record.isError === true || (record.error !== undefined && record.error !== null && record.error !== false)) {
      return { failed: true, message: textOf(record.error) || text || undefined };
    }
  }
  return { failed: false };
}

function obviousErrorText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^(error|exception|failed|failure)\b[:\s]/i.test(trimmed)) return true;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return record.isError === true || record.ok === false || (record.error !== undefined && record.error !== null && record.error !== false);
  } catch {
    return false;
  }
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return undefined;
}

function firstText(result: Record<string, unknown>): string {
  if (!Array.isArray(result.content)) return "";
  for (const item of result.content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) return text.trim().slice(0, 400);
  }
  return "";
}
