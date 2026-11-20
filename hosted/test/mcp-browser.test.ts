import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { renderMcpBrowserPage } from "../src/http/pages";

const env = {
  ISSUER: "https://lifediff.dev",
  MCP_SERVER_URL: "https://lifediff.dev/mcp",
} as Env;

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("browser GET /mcp", () => {
  it("keeps the 401 challenge and explains the MCP endpoint", async () => {
    const headers = { accept: "text/html" };
    const get = await worker.fetch(new Request("https://lifediff.dev/mcp", { headers }), env, ctx);
    const post = await worker.fetch(new Request("https://lifediff.dev/mcp", { method: "POST" }), env, ctx);
    expect(get.status).toBe(401);
    expect(post.status).toBe(401);
    const challenge = get.headers.get("WWW-Authenticate");
    expect(challenge).toBe(post.headers.get("WWW-Authenticate"));
    expect(challenge).toContain('Bearer realm="OAuth"');
    expect(challenge).toContain('resource_metadata="https://lifediff.dev/.well-known/oauth-protected-resource/mcp"');
    expect(get.headers.get("content-type")).toContain("text/html");
    expect(get.headers.get("cache-control")).toBe("no-store");
    const html = await get.text();
    expect(html).toContain("This is the Life Diff MCP endpoint");
    expect(html).toContain("https://lifediff.dev/mcp");
    expect(html).toContain("remote MCP server");
    expect(await post.text()).toBe("");
  });

  it("leaves a request that already has a bearer token on the resource server", async () => {
    const authed = {
      ...env,
      AUTH_SERVER: { validateToken: () => Promise.resolve(null) },
    } as Env;
    const response = await worker.fetch(new Request("https://lifediff.dev/mcp", {
      headers: { authorization: "Bearer not-a-token", accept: "text/html" },
    }), authed, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect(await response.text()).toBe("");
  });

  it("escapes the endpoint in the browser page", () => {
    const html = renderMcpBrowserPage("https://lifediff.dev/mcp?<script>");
    expect(html).toContain("https://lifediff.dev/mcp?&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
