const UPSTREAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,32}$/;
const TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export function validateUpstreamName(name: string): string {
  const trimmed = name.trim();
  if (!UPSTREAM_NAME.test(trimmed) || trimmed.includes("__")) {
    throw new Error("Name must start with a letter and use only letters, numbers, dashes, or underscores.");
  }
  return trimmed;
}

export function validateUpstreamUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("URL must be an https address.");
  }
  if (url.username || url.password) throw new Error("Put the token in the token field, not in the URL.");
  if (url.protocol === "https:") return url.toString();
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && local) return url.toString();
  throw new Error("URL must be https.");
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
