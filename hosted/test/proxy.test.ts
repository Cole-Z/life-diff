import { describe, expect, it } from "vitest";
import { encryptString } from "../src/crypto/aesgcm";
import { endSession, ensureSession, recordProxyCall, sessionPortFromBook } from "../src/app/service";
import { forwardToolCall } from "../src/proxy/forward";
import { classifyToolName, plainAction } from "../src/proxy/classify";
import { callUpstreamTool, listUpstreamTools, parseSse } from "../src/proxy/client";
import { namespaceTool, splitNamespaced } from "../src/proxy/namespace";
import { pickSubject, redactValue } from "../src/proxy/redact";
import { addUpstream, listPublicUpstreams } from "../src/proxy/upstreams";
import { renderHtml } from "../src/receipt/html";
import { SessionBook } from "../src/session/book";
import { MemoryMetadataStore, MemoryObjectStore } from "../src/storage/memory";
import type { GitHubApi } from "../src/github/types";

const now = new Date("2026-04-02T15:00:00.000Z");
const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

describe("classification and names", () => {
  it("treats write verbs as changes and read verbs as reads", () => {
    expect(classifyToolName("create_page")).toMatchObject({ effect: "write", tone: "created", verb: "create" });
    expect(classifyToolName("add_upstream")).toMatchObject({ tone: "created" });
    expect(classifyToolName("update_issue")).toMatchObject({ tone: "changed", verb: "update" });
    expect(classifyToolName("rename_file")).toMatchObject({ tone: "changed", verb: "rename" });
    expect(classifyToolName("delete_file")).toMatchObject({ tone: "removed", verb: "delete" });
    expect(classifyToolName("send_message")).toMatchObject({ effect: "write", tone: "removed", verb: "send" });
    expect(classifyToolName("get_or_create")).toMatchObject({ effect: "write", tone: "created" });
    expect(classifyToolName("search_and_delete")).toMatchObject({ tone: "removed" });
    expect(classifyToolName("list_pages")).toMatchObject({ effect: "read", tone: "read" });
    expect(classifyToolName("search_docs")).toMatchObject({ effect: "read" });
    expect(classifyToolName("read_wiki_structure")).toMatchObject({ effect: "read", verb: "read" });
    expect(classifyToolName("ask_wiki_question")).toMatchObject({ effect: "read", tone: "read", verb: "ask" });
    expect(classifyToolName("describe_repo")).toMatchObject({ effect: "read", verb: "describe" });
    expect(classifyToolName("lookup_user")).toMatchObject({ effect: "read", verb: "lookup" });
    expect(classifyToolName("check_status")).toMatchObject({ effect: "read", verb: "check" });
    expect(classifyToolName("get_receipt")).toMatchObject({ effect: "read", verb: "get" });
    expect(classifyToolName("check_and_delete")).toMatchObject({ effect: "write", tone: "removed" });
    expect(classifyToolName("fetch_user")).toMatchObject({ effect: "read" });
    expect(classifyToolName("query_rows")).toMatchObject({ effect: "read" });
    expect(classifyToolName("ping")).toMatchObject({ effect: "unknown", tone: "unknown" });
    expect(plainAction("deepwiki", classifyToolName("read_wiki_structure"), "facebook/react", true, "read_wiki_structure")).toBe("Looked up the docs outline for facebook/react in DeepWiki.");
    expect(plainAction("deepwiki", classifyToolName("ask_wiki_question"), "How does React work?", true, "ask_wiki_question")).toBe("Asked DeepWiki about 'How does React work?'.");
    expect(plainAction("deepwiki", classifyToolName("ping"), "pong", true, "ping")).toBe("Looked up 'pong' in DeepWiki.");
    expect(plainAction("slack", classifyToolName("send_message"), "hello", true)).toBe("Sent 'hello' from Slack.");
  });

  it("namespaces tools as upstream__tool", () => {
    expect(namespaceTool("deepwiki", "ask_question")).toBe("deepwiki__ask_question");
    expect(namespaceTool("deepwiki", "weird name")).toBe("deepwiki__weird_name");
    expect(splitNamespaced("deepwiki__ask_question")).toEqual({ upstream: "deepwiki", tool: "ask_question" });
    expect(splitNamespaced("start_session")).toBeNull();
  });
});

describe("subjects", () => {
  it("prefers the question over a repository name", () => {
    expect(pickSubject({ repo: "facebook/react", question: "How does React work?" })).toBe("How does React work?");
  });
});

describe("redaction", () => {
  it("removes secret-like keys and keeps the rest", () => {
    const redacted = redactValue({
      title: "Q2 goals",
      token: "sekret",
      api_key: "k",
      password: "p",
      Authorization: "Bearer x",
      cookie: "c",
      nested: { client_secret: "s", name: "notes" },
    });
    const encoded = JSON.stringify(redacted);
    expect(encoded).toContain("Q2 goals");
    expect(encoded).toContain("notes");
    expect(encoded).not.toContain("sekret");
    expect(encoded).not.toContain("Bearer x");
    expect(encoded).toContain("[redacted]");
  });
});

describe("upstream forwarding", () => {
  it("parses an SSE response and sends the session and auth on the tool call", async () => {
    const seen: { method: string; session: string | null; authorization: string | null; body: string }[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = String(init?.body ?? "");
      const message = JSON.parse(body) as { method?: string; id?: number };
      const headers = new Headers(init?.headers);
      seen.push({
        method: message.method ?? "",
        session: headers.get("mcp-session-id"),
        authorization: headers.get("authorization"),
        body,
      });
      if (message.method === "initialize") {
        return new Response(sse(`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"DeepWiki","version":"1"}}}`), {
          headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" },
        });
      }
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (message.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "read_wiki_structure", description: "Read the wiki" }] },
        });
      }
      return new Response(sse(`{"jsonrpc":"2.0","id":${message.id},"result":{"content":[{"type":"text","text":"Topics for facebook/react"}]}}`), {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const target = { name: "deepwiki", url: "https://mcp.deepwiki.com/mcp", auth: { header: "Authorization", value: "Bearer sekret-value" } };
    const tools = await listUpstreamTools(fetchImpl, target);
    expect(tools.map((tool) => namespaceTool("deepwiki", tool.name))).toEqual(["deepwiki__read_wiki_structure"]);
    const result = await callUpstreamTool(fetchImpl, target, "read_wiki_structure", { repoName: "facebook/react" });
    expect(JSON.stringify(result)).toContain("facebook/react");
    const calls = seen.filter((item) => item.method === "tools/call" || item.method === "tools/list");
    expect(calls.every((item) => item.session === "sess-1")).toBe(true);
    expect(calls.every((item) => item.authorization === "Bearer sekret-value")).toBe(true);
    expect(parseSse(`event: message\ndata: {"jsonrpc":"2.0","id":9,"result":{"ok":true}}\n\n`)[0]).toMatchObject({ id: 9 });
  });

  it("records a forwarded call, opens a session, and still records a failure", async () => {
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
      sessions: sessionPortFromBook(book),
      meta,
      objects,
      github: idleGithub(),
    };
    let toolCalls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const message = JSON.parse(String(init?.body ?? "")) as { method?: string; id?: number };
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (message.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } });
      }
      toolCalls += 1;
      if (toolCalls > 1) return new Response("Bearer sekret-value", { status: 500 });
      return new Response(sse(`{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"created"}]}}`), {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const target = { name: "notes", url: "https://mcp.example/mcp", auth: { header: "Authorization", value: "Bearer sekret-value" } };
    const ok = await forwardToolCall(deps, fetchImpl, target, "create_page", { title: "Q2 goals", token: "sekret-value" });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]?.text).toContain("created");
    expect(ok._meta?.sessionId).toBe(book.getOpen()?.id);
    expect(ok.content.at(-1)?.text).toBe(`Life Diff session ${book.getOpen()?.id}.`);
    expect(ok.content.at(-1)?._meta).toEqual({ sessionId: book.getOpen()?.id });
    expect(book.getOpen()?.snapshotKey).toBe("");
    const failed = await forwardToolCall({ ...deps, now: new Date("2026-04-02T15:05:00.000Z") }, fetchImpl, target, "delete_page", { title: "Q2 goals" });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]?.text).not.toContain("sekret-value");
    expect(failed._meta?.sessionId).toBe(book.getOpen()?.id);
    expect(JSON.stringify(failed)).not.toContain("sekret-value");
    const open = book.getOpen();
    expect(open).toBeTruthy();
    const logged = book.list(open!.id);
    expect(logged).toHaveLength(2);
    expect(logged[0]?.source).toBe("proxy");
    expect(JSON.stringify(logged[0]?.arguments)).not.toContain("sekret");
    expect(logged[1]?.ok).toBe(false);
    await recordProxyCall({ ...deps, now: new Date("2026-04-02T15:06:00.000Z") }, {
      upstream: "notes",
      tool: "list_pages",
      args: { query: "react" },
      ok: true,
      status: "ok",
      summary: "Looked up “react” in Notes.",
      classification: classifyToolName("list_pages"),
      durationMs: 4,
    });
    const ended = await endSession({ ...deps, now: new Date("2026-04-02T15:10:00.000Z") }, {});
    expect(ended.receipt.actions).toHaveLength(3);
    expect(ended.receipt.actions?.[0]?.summary).toBe("Created page 'Q2 goals' in Notes.");
    expect(ended.receipt.changes).toHaveLength(0);
    expect(ended.html).toContain("Seen by Life Diff");
    expect(ended.html).toContain("Verified lines come from a service");
    expect(ended.html.indexOf("Created page &#39;Q2 goals&#39;")).toBeLessThan(ended.html.indexOf("<details class=\"reads\">"));
    expect(ended.html).not.toContain("sekret");
    expect(ended.summary).toContain("Created page 'Q2 goals' in Notes.");
  });
});

describe("auto session and upstream secrets", () => {
  it("opens a session on the first recorded call", async () => {
    const book = new SessionBook();
    const meta = new MemoryMetadataStore();
    const deps = baseDeps(book, meta);
    expect(book.getOpen()).toBeNull();
    const logged = await recordProxyCall(deps, {
      upstream: "deepwiki",
      tool: "read_wiki_structure",
      args: { repoName: "facebook/react", password: "nope" },
      ok: true,
      status: "ok",
      summary: "Looked up “facebook/react” in Deepwiki.",
      classification: classifyToolName("read_wiki_structure"),
      durationMs: 12,
      result: "Topics",
    });
    expect(logged.sessionId).toBe(book.getOpen()?.id);
    expect(meta.sessions.size).toBe(1);
    const again = await ensureSession(deps);
    expect(again.id).toBe(logged.sessionId);
    expect(JSON.stringify(logged.arguments)).not.toContain("nope");
    const ended = await endSession({ ...deps, github: idleGithub() }, {});
    expect(book.getOpen()).toBeNull();
    expect(ended.receipt.actions?.[0]?.source).toBe("proxy");
  });

  it("stores an upstream token encrypted and does not return it", async () => {
    const meta = new MemoryMetadataStore();
    const added = await addUpstream(meta, "42", KEY, now, {
      name: "deepwiki",
      url: "https://mcp.deepwiki.com/mcp",
      token: "sekret-value",
    });
    expect(added).toMatchObject({ name: "deepwiki", hasToken: true });
    expect(JSON.stringify(added)).not.toContain("sekret-value");
    const stored = [...meta.upstreams.values()][0];
    expect(stored?.authEnc).toBeTruthy();
    expect(stored?.authEnc).not.toContain("sekret-value");
    expect(await encryptString(KEY, "sekret-value")).not.toBe(stored?.authEnc);
    const listed = await listPublicUpstreams(meta, "42");
    expect(JSON.stringify(listed)).not.toContain("sekret-value");
    expect(listed[0]?.hasToken).toBe(true);
    const html = renderHtml({
      schemaVersion: "1.0.0",
      id: "rcpt_test",
      generatedAt: now.toISOString(),
      readOnly: true,
      producer: { name: "lifediff-hosted", version: "0.1.0" },
      snapshot: { id: "none", takenAt: now.toISOString() },
      comparedAt: now.toISOString(),
      timeZone: "UTC",
      session: { startedAt: now.toISOString(), checkedAt: now.toISOString() },
      github: { repos: [], diffMode: "snapshot", truncatedSnapshot: false, truncatedChanges: false, suppressedRemovals: false },
      counts: { added: 0, removed: 0, modified: 0, verifiedClaims: 0, missingClaims: 0, unclaimedChanges: 0 },
      changes: [],
      claimsChecked: false,
      claims: [],
      notes: [],
      actions: [{
        id: "act_1",
        time: now.toISOString(),
        upstream: "deepwiki",
        tool: "read_wiki_structure",
        summary: "Looked up “facebook/react” in Deepwiki.",
        tone: "read",
        effect: "read",
        ok: true,
        status: "ok",
        source: "proxy",
        arguments: { repoName: "facebook/react" },
      }],
    });
    expect(html).toContain("<details class=\"reads\">");
    expect(html).toContain("badge-read");
    expect(html).toContain("Seen by Life Diff");
  });
});

function sse(data: string): string {
  return `event: message\ndata: ${data}\n\n`;
}

function baseDeps(book: SessionBook, meta: MemoryMetadataStore) {
  return {
    userId: "42",
    login: "octocat",
    now,
    timeZone: "UTC",
    maxRepos: 25,
    receiptRetentionDays: 90,
    snapshotRetentionHours: 24,
    abandonedSessionDays: 7,
    sessions: sessionPortFromBook(book),
    meta,
    objects: new MemoryObjectStore(),
  };
}

function idleGithub(): GitHubApi {
  const fail = async (): Promise<never> => {
    throw new Error("GitHub should not be called");
  };
  return {
    listInstallations: fail,
    listInstallationRepos: fail,
    listBranches: fail,
    listPulls: fail,
    listIssues: fail,
    listCommits: fail,
    compare: fail,
    listIssueComments: fail,
    listReviewComments: fail,
  };
}
