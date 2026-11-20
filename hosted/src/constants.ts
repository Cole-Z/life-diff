/** Public production URLs. Runtime code prefers the Worker env so local dev can override them. */
export const SITE_ORIGIN = "https://lifediff.dev";
export const MCP_PATH = "/mcp";
export const MCP_URL = `${SITE_ORIGIN}${MCP_PATH}`;
export const GITHUB_CALLBACK_PATH = "/callback";
export const GITHUB_CALLBACK_URL = `${SITE_ORIGIN}${GITHUB_CALLBACK_PATH}`;

export const SCHEMA_VERSION = "1.0.0";
export const HOSTED_VERSION = "0.1.0";
export const PRODUCER_NAME = "lifediff-hosted";

export const SCOPES = ["receipts:read", "sessions:write"] as const;
export type Scope = (typeof SCOPES)[number];
