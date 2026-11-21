import { CLIENT_INFO_META_KEY, type McpServer, type ServerContext } from "@modelcontextprotocol/server";

/** The MCP client's own name, from this request or from initialize. */
export function clientName(server: McpServer, ctx?: ServerContext): string | undefined {
  const fromRequest = readClient(ctx?.mcpReq.envelope) ?? readClient(ctx?.mcpReq._meta);
  if (fromRequest) return fromRequest;
  const version = server.server.getClientVersion();
  return clip(version?.name);
}

function readClient(value: object | undefined): string | undefined {
  if (!value) return undefined;
  const raw = (value as Record<string, unknown>)[CLIENT_INFO_META_KEY];
  if (typeof raw === "string") return clip(raw);
  if (raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string") {
    return clip((raw as { name: string }).name);
  }
  return undefined;
}

function clip(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 80);
}
