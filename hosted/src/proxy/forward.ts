import type { CoreDeps } from "../app/service";
import { recordProxyCall } from "../app/service";
import { classifyToolName, plainAction } from "./classify";
import { callUpstreamTool, UpstreamError, type UpstreamTarget } from "./client";
import { boundJson, pickSubject, scrubSecrets } from "./redact";

export interface ToolReply {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export async function forwardToolCall(deps: CoreDeps, fetchImpl: typeof fetch, target: UpstreamTarget, tool: string, args: unknown): Promise<ToolReply> {
  const started = Date.now();
  const classification = classifyToolName(tool);
  const secrets = target.auth?.value ? [target.auth.value] : [];
  try {
    const result = await callUpstreamTool(fetchImpl, target, tool, args);
    const durationMs = Date.now() - started;
    const failed = result.isError === true;
    const resultText = scrubSecrets(firstText(result), secrets);
    const summary = plainAction(target.name, classification, pickSubject(boundJson(args)), !failed);
    await recordSafe(deps, {
      upstream: target.name,
      tool,
      args,
      ok: !failed,
      status: failed ? "error" : "ok",
      summary,
      classification,
      durationMs,
      ...(resultText ? { result: resultText } : {}),
      ...(failed ? { error: resultText || "The upstream reported an error." } : {}),
    });
    return replyFrom(result, target.name, tool);
  } catch (error) {
    const durationMs = Date.now() - started;
    const message = scrubSecrets(error instanceof UpstreamError || error instanceof Error ? error.message : "The upstream call failed.", secrets);
    const summary = plainAction(target.name, classification, pickSubject(boundJson(args)), false);
    await recordSafe(deps, {
      upstream: target.name,
      tool,
      args,
      ok: false,
      status: "error",
      summary,
      classification,
      durationMs,
      error: message,
    });
    return {
      isError: true,
      content: [{ type: "text", text: message || `${target.name} failed.` }],
    };
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
}): Promise<void> {
  try {
    await recordProxyCall(deps, input);
  } catch {
    // The agent still receives the upstream result when the log cannot be written.
  }
}

function replyFrom(result: Record<string, unknown>, upstream: string, tool: string): ToolReply {
  const content = Array.isArray(result.content)
    ? result.content.flatMap((item) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
      if (!record || record.type !== "text" || typeof record.text !== "string") return [];
      return [{ type: "text" as const, text: record.text }];
    })
    : [];
  const reply: ToolReply = {
    content: content.length > 0 ? content : [{ type: "text", text: `${upstream} completed ${tool}.` }],
  };
  if (result.isError === true) reply.isError = true;
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) {
    reply.structuredContent = result.structuredContent as Record<string, unknown>;
  }
  return reply;
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
