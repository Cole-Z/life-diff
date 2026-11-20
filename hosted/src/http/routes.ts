export type RouteKind = "mcp" | "resource-metadata" | "data" | "app";

export function classify(pathname: string): RouteKind {
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return "mcp";
  if (pathname === "/.well-known/oauth-protected-resource" || pathname.startsWith("/.well-known/oauth-protected-resource/")) {
    return "resource-metadata";
  }
  if (pathname === "/v1/me" || pathname.startsWith("/v1/") || pathname.startsWith("/receipts/")) return "data";
  return "app";
}
