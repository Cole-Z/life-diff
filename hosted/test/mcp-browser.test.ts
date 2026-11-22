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

  it("offers a deterministic public sample and setup links from protected pages", async () => {
    const get = (path: string) => worker.fetch(new Request(`https://lifediff.dev${path}`), env, ctx);
    const home = await get("/");
    const landing = await home.text();
    expect(landing).toContain("Get a receipt for what your AI agents changed");
    expect(landing.match(/<article class="row /g)).toHaveLength(3);
    expect(landing).toContain('href="/sample-receipt"');
    expect(landing).toContain('href="#connect"');
    const sample = await get("/sample-receipt");
    expect(sample.status).toBe(200);
    const html = await sample.text();
    expect(await (await get("/sample-receipt")).text()).toBe(html);
    expect(html.match(/<article class="row /g)).toHaveLength(4);
    for (const label of ["Verified", "Agent said", "Failed", "QA-42", "1 lookup", "9:30 AM → 10:00 AM", "example-org/launch-sandbox"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toMatch(/\/receipts\/|\?t=/);
    for (const [path, heading, status] of [["/settings", "Settings", 401], ["/roundup", "Today", 401], ["/account", "Account", 200]] as const) {
      const response = await get(path);
      expect(response.status).toBe(status);
      const page = await response.text();
      expect(page).toContain(`<h1>${heading}</h1>`);
      expect(page).toContain('href="/#connect"');
      expect(page).toContain('href="/sample-receipt"');
    }
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
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain("mcp?<script>");
  });
});
