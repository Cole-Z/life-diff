import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { classifyTool } from "../src/proxy/classify";
import { authHeaders, callUpstreamTool, listUpstreamTools } from "../src/proxy/forward";
import { namespacedTool, splitNamespacedTool } from "../src/proxy/namespace";
import { isSecretKey, redactValue } from "../src/proxy/redact";
import { addUpstream, listUpstreamPublic, loadUpstreamSecrets } from "../src/proxy/registry";
import { jsonSchema } from "../src/proxy/schema";
import { plainAction } from "../src/proxy/summary";
import { actionsToClaims } from "../src/actions/log";
import { endSession, ensureRecordingSession, recordProxyCall, sessionPortFromBook, startSession } from "../src/app/service";
import { encryptString } from "../src/crypto/aesgcm";
import { renderSettings } from "../src/http/pages";
import { SessionBook } from "../src/session/book";
import { MemoryMetadataStore, MemoryObjectStore } from "../src/storage/memory";
import type { GitHubApi } from "../src/github/types";

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const now = new Date("2026-04-02T15:00:00.000Z");

describe("classification", () => {
  it("treats write verbs as writes and read verbs as reads", () => {
    expect(classifyTool("create_file")).toEqual({ effect: "write", tone: "added" });
    expect(classifyTool("addLabel")).toEqual({ effect: "write", tone: "added" });
    expect(classifyTool("update_event")).toEqual({ effect: "write", tone: "changed" });
    expect(classifyTool("editPage")).toEqual({ effect: "write", tone: "changed" });
    expect(classifyTool("delete_message")).toEqual({ effect: "write", tone: "removed" });
    expect(classifyTool("send_email")).toEqual({ effect: "write", tone: "removed" });
    expect(classifyTool("search_cloudflare_documentation")).toEqual({ effect: "read", tone: "read" });
    expect(classifyTool("getUser")).toEqual({ effect: "read", tone: "read" });
    expect(classifyTool("list_files")).toEqual({ effect: "read", tone: "read" });
    expect(classifyTool("migrate_pages_to_workers_guide")).toEqual({ effect: "unknown", tone: "unknown" });
    expect(classifyTool("get_or_create")).toEqual({ effect: "write", tone: "added" });
  });
});

describe("redaction", () => {
  it("redacts secret keys and leaves ordinary fields", () => {
    expect(isSecretKey("api_key")).toBe(true);
    expect(isSecretKey("accessToken")).toBe(true);
    expect(isSecretKey("password")).toBe(true);
    expect(isSecretKey("Authorization")).toBe(true);
    expect(isSecretKey("keyboard")).toBe(false);
    expect(isSecretKey("query")).toBe(false);
    const redacted = redactValue({
      query: "Durable Objects",
      api_key: "super-secret",
      nested: { password: "hunter2", title: "Notes" },
      authorization: "Bearer abc",
    }) as { query: string; api_key: string; nested: { password: string; title: string }; authorization: string };
    expect(redacted.query).toBe("Durable Objects");
    expect(redacted.api_key).toBe("[redacted]");
    expect(redacted.nested.password).toBe("[redacted]");
    expect(redacted.nested.title).toBe("Notes");
    expect(redacted.authorization).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain("super-secret");
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });
});

describe("namespacing", () => {
  it("prefixes the upstream and splits it back apart", () => {
    expect(namespacedTool("docs", "search_cloudflare_documentation")).toBe("docs__search_cloudflare_documentation");
    expect(splitNamespacedTool("docs__search_cloudflare_documentation")).toEqual({
      upstream: "docs",
      tool: "search_cloudflare_documentation",
    });
    expect(namespacedTool("docs", "has space")).toBeNull();
    expect(splitNamespacedTool("start_session")).toBeNull();
  });

  it("keeps an upstream JSON schema on a registered tool", () => {
    const server = new McpServer({ name: "lifediff", version: "0.1.0" });
    const registered = server.registerTool("docs__search", {
      description: "Search",
      inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
    }, async () => ({ content: [{ type: "text", text: "ok" }] }));
    expect(registered.enabled).toBe(true);
  });
});

describe("forwarding", () => {
  it("lists tools over SSE and calls them with the bearer token", async () => {
    const seen: { method: string; authorization: string; session?: string }[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string; arguments?: { query?: string } } };
      const headers = new Headers(init?.headers);
      seen.push({
        method: body.method,
        authorization: headers.get("authorization") ?? "",
        ...(headers.get("mcp-session-id") ? { session: headers.get("mcp-session-id") ?? "" } : {}),
      });
      if (init?.redirect !== "manual") throw new Error("redirects must not be followed");
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }, {
          headers: { "mcp-session-id": "up_1" },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        const payload = {
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "search_cloudflare_documentation", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } } } }] },
        };
        return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      expect(body.params?.arguments?.query).toBe("Durable Objects");
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "A Durable Object keeps state." }] },
      });
    };
    const upstream = { name: "docs", url: "https://docs.mcp.cloudflare.com/mcp", token: "super-secret" };
    const tools = await listUpstreamTools(upstream, fetchImpl);
    expect(tools.map((tool) => tool.name)).toEqual(["search_cloudflare_documentation"]);
    const call = await callUpstreamTool(upstream, "search_cloudflare_documentation", { query: "Durable Objects" }, fetchImpl);
    expect(call.ok).toBe(true);
    expect(call.resultSummary).toContain("Durable Object");
    expect(seen.some((item) => item.method === "tools/call" && item.authorization === "Bearer super-secret" && item.session === "up_1")).toBe(true);
    expect(JSON.stringify(seen)).not.toContain("super-secret-in-url");
    expect(authHeaders("X-Api-Key: abc")).toEqual({ "X-Api-Key": "abc" });
  });

  it("records an upstream error without the token", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "initialize") return new Response("no", { status: 500 });
      if (body.method === "tools/call") return new Response("nope", { status: 502 });
      return new Response("no", { status: 404 });
    };
    const call = await callUpstreamTool(
      { name: "docs", url: "https://example.com/mcp", token: "super-secret" },
      "search_docs",
      { query: "x" },
      fetchImpl,
    );
    expect(call.ok).toBe(false);
    expect(call.error).toContain("502");
    expect(call.error).not.toContain("super-secret");
  });

  it("does not follow a redirect that could carry the token", async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ ok: true }, { status: 302, headers: { location: "https://evil.example/mcp" } });
    const call = await callUpstreamTool({ name: "docs", url: "https://example.com/mcp", token: "super-secret" }, "search", {}, fetchImpl);
    expect(call.ok).toBe(false);
    expect(call.error).toContain("redirect");
    expect(call.error).not.toContain("super-secret");
  });
});

describe("auto session", () => {
  it("opens a session on the first forwarded call and keeps later calls on it", async () => {
    const book = new SessionBook();
    const deps = {
      userId: "42",
      login: "octocat",
      now,
      timeZone: "UTC",
      maxRepos: 25,
      receiptRetentionDays: 90,
      snapshotRetentionHours: 24,
      abandonedSessionDays: 7,
      sessions: sessionPortFromBook(book),
      meta: new MemoryMetadataStore(),
      objects: new MemoryObjectStore(),
    };
    const first = await recordProxyCall(deps, {
      upstream: "docs",
      tool: "search_cloudflare_documentation",
      args: { query: "Durable Objects", api_key: "super-secret" },
      ok: true,
      durationMs: 40,
      resultSummary: "A Durable Object keeps state.",
    });
    const second = await recordProxyCall({ ...deps, now: new Date("2026-04-02T15:01:00.000Z") }, {
      upstream: "docs",
      tool: "delete_page",
      args: { title: "Old draft", password: "hunter2" },
      ok: false,
      error: "The upstream returned HTTP 500.",
      durationMs: 12,
      resultSummary: "The upstream returned HTTP 500.",
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(book.getOpen()?.recordingOnly).toBe(true);
    const logged = book.list(first.sessionId);
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toContain("super-secret");
    expect(JSON.stringify(logged)).not.toContain("hunter2");
    expect(logged[0]?.effect).toBe("read");
    expect(logged[1]?.tone).toBe("removed");
    expect(logged[0]?.summary).toBe('Looked up "Durable Objects" in Docs.');
    expect(actionsToClaims(logged)).toEqual([]);
    const open = await ensureRecordingSession(deps);
    expect(open.id).toBe(first.sessionId);
  });

  it("puts proxy calls on the receipt and still verifies GitHub", async () => {
    const book = new SessionBook();
    const meta = new MemoryMetadataStore();
    const objects = new MemoryObjectStore();
    const deps = {
      userId: "42",
      login: "octocat",
      now,
      timeZone: "UTC",
      maxRepos: 25,
      receiptRetentionDays: 90,
      snapshotRetentionHours: 24,
      abandonedSessionDays: 7,
      github: fakeApi(),
      sessions: sessionPortFromBook(book),
      meta,
      objects,
    };
    await recordProxyCall(deps, {
      upstream: "docs",
      tool: "search_cloudflare_documentation",
      args: { query: "Workers" },
      ok: true,
      durationMs: 8,
      resultSummary: "Workers run JavaScript.",
    });
    await startSession(deps, {});
    expect(book.getOpen()?.recordingOnly).toBeUndefined();
    expect(book.list(book.getOpen()?.id ?? "")).toHaveLength(1);
    const ended = await endSession({ ...deps, now: new Date("2026-04-02T15:40:00.000Z") }, {});
    expect(ended.receipt.actions?.[0]?.summary).toContain("Workers");
    expect(ended.receipt.actions?.[0]?.source).toBe("proxy");
    expect(ended.receipt.claimsChecked).toBe(false);
    expect(ended.html).toContain("Reported by proxy");
    expect(ended.html).toContain("Verified from service history");
    expect(ended.html).toContain("badge-read");
    expect(ended.html).toContain("<details");
    expect(ended.summary).toContain("reported by the proxy");
  });
});

describe("upstream registry", () => {
  it("stores the token encrypted and does not return it", async () => {
    const meta = new MemoryMetadataStore();
    const saved = await addUpstream(meta, KEY, "42", now, {
      name: "Docs",
      url: "https://docs.mcp.cloudflare.com/mcp",
      token: "super-secret",
    });
    expect(saved.hasToken).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("super-secret");
    const listed = await listUpstreamPublic(meta, "42");
    expect(listed[0]?.name).toBe("docs");
    expect(JSON.stringify(listed)).not.toContain("super-secret");
    const row = meta.upstreams.get("42\ndocs");
    expect(row?.tokenEnc).toBeTruthy();
    expect(row?.tokenEnc).not.toContain("super-secret");
    expect(await encryptString(KEY, "other")).not.toBe(row?.tokenEnc);
    const secrets = await loadUpstreamSecrets(meta, KEY, "42");
    expect(secrets[0]?.token).toBe("super-secret");
    const page = renderSettings("octocat", "csrf", listed);
    expect(page).toContain("docs.mcp.cloudflare.com");
    expect(page).not.toContain("super-secret");
    expect(page).toContain("A token is saved");
  });
});

function plainSentence(): void {
  expect(plainAction({ upstream: "docs", tool: "create_page", args: { title: "Q2 goals" }, ok: true })).toBe('Created "Q2 goals" in Docs.');
}

describe("summaries", () => {
  it("uses a plain sentence", () => {
    plainSentence();
    expect(plainAction({ upstream: "slack", tool: "send_message", args: { text: "Hello" }, ok: true })).toBe('Sent "Hello" in Slack.');
    expect(plainAction({ upstream: "docs", tool: "delete_page", args: { title: "Old" }, ok: false })).toContain("reported an error");
  });
});

function fakeApi(): GitHubApi {
  let branchReads = 0;
  return {
    async listInstallations() {
      return [{ id: 1, accountLogin: "acme" }];
    },
    async listInstallationRepos() {
      return { truncated: false, repos: [{ fullName: "acme/app", installationId: 1, defaultBranch: "main" }] };
    },
    async listBranches() {
      branchReads += 1;
      const sha = branchReads === 1 ? "aaa1111" : "ccc3333";
      return { truncated: false, branches: [{ name: "main", sha }] };
    },
    async listPulls() {
      return { truncated: false, pulls: [] };
    },
    async listIssues() {
      return { truncated: false, issues: [] };
    },
    async listCommits() {
      return { truncated: false, commits: [] };
    },
    async compare() {
      return { truncated: false, files: [] };
    },
    async listIssueComments() {
      return { truncated: false, comments: [] };
    },
    async listReviewComments() {
      return { truncated: false, comments: [] };
    },
  };
}
