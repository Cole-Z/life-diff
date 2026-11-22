import type { Env } from "../env";

export const DEEPWIKI_ENDPOINT = "https://mcp.deepwiki.com/mcp";

const UPSTREAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,32}$/;
const TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export function validateUpstreamName(name: string): string {
  const trimmed = name.trim();
  if (!UPSTREAM_NAME.test(trimmed) || trimmed.includes("__")) {
    throw new Error("Name must start with a letter and use only letters, numbers, dashes, or underscores.");
  }
  return trimmed;
}

export function approvedUpstreamEndpoints(env: Pick<Env, "APPROVED_UPSTREAM_ENDPOINTS" | "ENVIRONMENT" | "ISSUER">): ReadonlySet<string> {
  const issuer = URL.parse(env.ISSUER);
  const local = env.ENVIRONMENT === "development" && issuer !== null && isLoopback(issuer);
  const endpoints = new Set<string>();
  for (const configured of (env.APPROVED_UPSTREAM_ENDPOINTS ?? DEEPWIKI_ENDPOINT).split(",")) {
    const endpoint = parseUpstreamUrl(configured);
    if (endpoint && (!isLoopback(endpoint) ? endpoint.protocol === "https:" : local && ["https:", "http:"].includes(endpoint.protocol))) {
      endpoints.add(endpoint.href);
    }
  }
  return endpoints;
}

export function approvedUpstreamUrl(raw: string, endpoints: ReadonlySet<string>): string | undefined {
  const url = parseUpstreamUrl(raw);
  if (url && endpoints.has(url.href)) return url.href;
  return undefined;
}

function parseUpstreamUrl(raw: string): URL | null {
  // Reject even empty query and fragment delimiters and drop legacy URLs from public output.
  const authority = /^https?:\/\/([^/?#\\]+)/i.exec(raw.trim())?.[1];
  if (!authority || authority.includes("@") || /[?#]/.test(raw)) return null;
  const url = URL.parse(raw.trim());
  return url && !url.username && !url.password ? url : null;
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host)
    || host === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:/.test(host);
}

export function validUpstreamAuthHeader(header: string): boolean {
  return /^[A-Za-z0-9-]{1,40}$/.test(header) && !/^(?:host$|forwarded$|x-forwarded-|cf-|proxy-)/i.test(header);
}

export function namespaceTool(upstream: string, tool: string): string | null {
  const cleaned = tool.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) return null;
  const name = `${upstream}__${cleaned}`;
  if (!TOOL_NAME.test(name)) return null;
  return name;
}

export function splitNamespaced(name: string): { upstream: string; tool: string } | null {
  const index = name.indexOf("__");
  if (index <= 0 || index >= name.length - 2) return null;
  return { upstream: name.slice(0, index), tool: name.slice(index + 2) };
}
