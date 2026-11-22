import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionPortFromBook } from "../src/app/service";
import { SCOPES } from "../src/constants";
import { sessionCookieHeader, signSession } from "../src/crypto/cookie";
import type { Env } from "../src/env";
import worker from "../src/index";
import { clearUpstreamCache } from "../src/mcp/upstream-tools";
import { DEEPWIKI_ENDPOINT } from "../src/proxy/namespace";
import { SessionBook } from "../src/session/book";
import { D1MetadataStore, type Sql } from "../src/storage/d1";

const origin = "https://lifediff.dev";
const key = "fixture-cookie-signing-key-for-hosted-tests";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

afterEach(() => {
  clearUpstreamCache();
  vi.unstubAllGlobals();
});

describe("approved lookup and browser-only deletion", () => {
  it("lists only approved tool endpoints and completes the existing lookup and receipt flow", async () => {
    const { meta, account, request, rpc } = setup();
    const alice = await account("42", true);
    await meta.insertUpstream({
      id: "fixture-old", userId: alice.id, name: "old", url: `${DEEPWIKI_ENDPOINT}?token=fixture-query-value`, createdAt: new Date().toISOString(),
    });
    const upstream = mockDeepWiki();
    const added = await rpc(alice.token, "tools/call", { name: "add_upstream", arguments: { name: "deepwiki", url: DEEPWIKI_ENDPOINT } });
    expect(added.structuredContent?.upstream).toMatchObject({ status: "approved", url: DEEPWIKI_ENDPOINT });
    const saved = await rpc(alice.token, "tools/call", { name: "list_upstreams", arguments: {} });
    expect(saved.structuredContent?.upstreams).toEqual(expect.arrayContaining([expect.objectContaining({ name: "old", status: "blocked" })]));
    expect(JSON.stringify(saved)).not.toContain("fixture-query-value");
    const settings = await request("/settings", { headers: { cookie: alice.cookie } });
    expect(settings.status).toBe(200);
    const settingsHtml = await settings.text();
    expect(settingsHtml).toContain("Blocked by the endpoint policy");
    expect(settingsHtml).not.toContain("fixture-query-value");
    const catalog = await rpc(alice.token, "tools/list", {});
    expect(catalog.tools?.map(({ name }) => name)).toContain("deepwiki__read_wiki_structure");
    expect(catalog.tools?.map(({ name }) => name)).not.toContain("clear_my_history");
    expect(catalog.tools?.some(({ name }) => name.startsWith("old__"))).toBe(false);
    const receipt = await lookup(rpc, alice.token);
    expect(receipt.body).toBe("Nothing changed · 1 lookup");
    expect(receipt.receipt.actions).toEqual([expect.objectContaining({ source: "proxy", effect: "read", tool: "read_wiki_structure" })]);
    expect(receipt.receipt.changes).toEqual([]);
    const fetched = await rpc(alice.token, "tools/call", { name: "get_receipt", arguments: { receiptId: receipt.receipt.id } });
    expect(fetched.content?.map(({ type }) => type)).toEqual(["text", "image"]);
    expect(upstream.mock.calls.map(([url]) => url).every((url) => url === DEEPWIKI_ENDPOINT)).toBe(true);

    const denied = await request("/v1/me", { method: "DELETE", headers: { authorization: `Bearer ${alice.token}` } });
    expect(denied.status).toBe(404);
    const staleCall = await rpc(alice.token, "tools/call", { name: "clear_my_history", arguments: { confirm: true } });
    expect(staleCall.error?.message).toMatch(/clear_my_history|not found/i);
    expect(await meta.getAccessVersions(alice.id)).not.toBeNull();
    expect(await meta.getReceipt(alice.id, receipt.receipt.id)).not.toBeNull();
    clearUpstreamCache();
    const redirect = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 307, headers: { location: "https://fixture.example.test/?token=fixture-redirect-value" },
    }));
    vi.stubGlobal("fetch", redirect);
    const discovery = await rpc(alice.token, "tools/call", { name: "list_upstreams", arguments: {} });
    expect(discovery.content?.[0]?.text).toContain("Configure the final HTTPS endpoint.");
    expect(JSON.stringify(discovery)).not.toContain("fixture-redirect-value");
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("uses session CSRF and confirmation, invalidates old views, and isolates account deletion", async () => {
    const { account, request, rpc, meta, grants } = setup();
    const alice = await account("42");
    const bob = await account("43");
    mockDeepWiki();
    for (const user of [alice, bob]) {
      await rpc(user.token, "tools/call", { name: "add_upstream", arguments: { name: "deepwiki", url: DEEPWIKI_ENDPOINT } });
    }
    const first = await lookup(rpc, alice.token);
    const bobReceipt = await lookup(rpc, bob.token);
    const foreign = await request(`/receipts/${first.receipt.id}.json`, { headers: { authorization: `Bearer ${bob.token}` } });
    expect(foreign.status).toBe(400);
    expect(await foreign.text()).not.toContain("facebook/react");
    const owner = await request(`/receipts/${first.receipt.id}.json`, { headers: { authorization: `Bearer ${alice.token}` } });
    expect(owner.status).toBe(200);
    expect(owner.headers.get("cache-control")).toBe("private, no-store");

    const day = await rpc(alice.token, "tools/call", { name: "get_daily_diff", arguments: {} });
    const oldDay = String(day.structuredContent?.viewUrl);
    const oldCard = String(day.structuredContent?.imageUrl);
    expect((await request(oldDay)).status).toBe(200);
    expect((await request(oldCard)).headers.get("content-type")).toBe("image/png");
    expect((await request(first.viewUrl)).status).toBe(200);
    const oldAccount = await request("/account", { headers: { cookie: alice.cookie } });
    expect(await oldAccount.text()).toContain('name="confirm" value="delete" required');

    const browserPost = (path: string, fields: Record<string, string>, cookie = alice.cookie) =>
      request(path, { method: "POST", headers: { cookie }, body: new URLSearchParams(fields) });
    for (const [path, confirm] of [["/settings/clear", "yes"], ["/account/delete", "delete"]] as const) {
      expect((await browserPost(path, { csrf: bob.csrf, confirm })).status).toBe(400);
      expect((await browserPost(path, { csrf: alice.csrf })).status).toBe(400);
      expect((await request(path, {
        method: "POST", headers: { authorization: `Bearer ${alice.token}` }, body: new URLSearchParams({ csrf: alice.csrf, confirm }),
      })).status).toBe(401);
    }
    expect((await request(first.viewUrl)).status).toBe(200);
    expect((await browserPost("/settings/clear", { csrf: alice.csrf, confirm: "yes", userId: bob.id })).status).toBe(303);
    expect((await request(first.viewUrl)).status).toBe(401);
    expect(await meta.getReceipt(alice.id, first.receipt.id)).toBeNull();
    expect((await request(bobReceipt.viewUrl)).status).toBe(200);

    const second = await lookup(rpc, alice.token);
    expect(second.receipt.id).not.toBe(first.receipt.id);
    const replacement = await rpc(alice.token, "tools/call", { name: "get_daily_diff", arguments: {} });
    const newDay = String(replacement.structuredContent?.viewUrl);
    expect((await request(oldDay)).status).toBe(401);
    expect((await request(oldCard)).status).toBe(401);
    expect(await (await request(newDay)).text()).toContain("1 lookup");

    const otherBrowser = await alice.newCookie("other-browser");
    const deleted = await browserPost("/account/delete", { csrf: alice.csrf, confirm: "delete", userId: bob.id });
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await request("/settings", { headers: { cookie: otherBrowser } })).status).toBe(401);
    expect((await request(newDay)).status).toBe(401);
    expect((await request(second.viewUrl)).status).toBe(401);
    expect(await meta.getReceipt(alice.id, second.receipt.id)).toBeNull();
    expect(await meta.getAccessVersions(alice.id)).toBeNull();
    expect([...grants.keys()]).toEqual(["grant:43:fixture", "token:43:fixture:access"]);
    expect((await request("/mcp", { headers: { authorization: `Bearer ${alice.token}` } })).status).toBe(401);
    expect((await request(bobReceipt.viewUrl)).status).toBe(200);

    await account(alice.id);
    expect((await request("/settings", { headers: { cookie: otherBrowser } })).status).toBe(401);
    expect((await request("/mcp", { headers: { authorization: `Bearer ${alice.token}` } })).status).toBe(401);
    expect((await request(newDay)).status).toBe(401);
  });
});

function setup() {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(file, migrations), "utf8"));
  const sql: Sql = {
    prepare(query) {
      const statement = db.prepare(query);
      let bindings: SQLInputValue[] = [];
      return {
        bind(...values) { bindings = values as SQLInputValue[]; return this; },
        async first<T>() { return (statement.get(...bindings) ?? null) as T | null; },
        async all<T>() { return { results: statement.all(...bindings) as T[] }; },
        async run() { return { meta: statement.run(...bindings) }; },
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const statement of statements) await statement.run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const meta = new D1MetadataStore(sql);
  const grants = new Map<string, unknown>();
  const tokens = new Map<string, { userId: string; login: string; accountVersion?: string }>();
  const sessions = new Map<string, ReturnType<typeof sessionPortFromBook> & { wipe: () => void }>();
  const objects = new Map<string, Uint8Array | string>();
  const env = {
    DB: sql,
    RECEIPTS: {
      async put(objectKey: string, data: string | Uint8Array) { objects.set(objectKey, data); },
      async get(objectKey: string) {
        const body = objects.get(objectKey);
        return body === undefined ? null : new Response(body);
      },
      async delete(keys: string[]) { for (const objectKey of keys) objects.delete(objectKey); },
    },
    USER_SESSIONS: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!sessions.has(id)) {
          const book = new SessionBook();
          sessions.set(id, { ...sessionPortFromBook(book), wipe: () => book.wipe() });
        }
        return sessions.get(id);
      },
    },
    OAUTH_KV: {
      get: async (name: string) => grants.get(name) ?? null,
      list: async ({ prefix }: { prefix: string }) => ({
        keys: [...grants.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
      delete: async (name: string) => { grants.delete(name); },
    },
    AUTH_SERVER: {
      validateToken: async (resource: string, token: string) => {
        const props = tokens.get(token);
        return props ? { props, userId: props.userId, scope: [...SCOPES], audience: resource, expiresAt: 2e9, clientId: "fixture" } : null;
      },
    },
    ISSUER: origin,
    MCP_SERVER_URL: origin + "/mcp",
    ENVIRONMENT: "production",
    COOKIE_SIGNING_KEY: key,
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  } as unknown as Env;
  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(new URL(path, origin), init), env, ctx);

  async function account(id: string, migrated = false) {
    const login = "fixture-" + id;
    if (migrated) {
      db.prepare("INSERT INTO users (id, login, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, login, "2026-11-20", "2026-11-20");
    }
    const { accountVersion } = await meta.upsertUser({ id, login, now: new Date().toISOString() });
    const token = crypto.randomUUID();
    const csrf = "csrf-" + id;
    const credentials = migrated ? {} : { accountVersion };
    tokens.set(token, { userId: id, login, ...credentials });
    grants.set(`grant:${id}:fixture`, { id: "fixture", userId: id, clientId: "fixture", scope: [...SCOPES] });
    grants.set(`token:${id}:fixture:access`, {});
    const newCookie = async (csrf: string) => sessionCookieHeader(
      await signSession(key, { sub: id, login, ...credentials, csrf, exp: Math.floor(Date.now() / 1000) + 600 }), 600,
    ).split(";")[0]!;
    return { id, token, csrf, cookie: await newCookie(csrf), newCookie };
  }

  async function rpc(token: string, method: string, params: Record<string, unknown>): Promise<RpcResult> {
    const response = await request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const data = responseText.startsWith("{") ? responseText : responseText.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    const message = JSON.parse(data ?? "{}") as { result?: RpcResult; error?: { message: string } };
    if (message.error) return { error: message.error };
    expect(message.result, method).toBeTruthy();
    return message.result!;
  }

  return { meta, account, request, rpc, grants };
}

interface RpcResult {
  content?: { text?: string; type: string }[];
  structuredContent?: Record<string, unknown>;
  _meta?: { sessionId?: string };
  tools?: { name: string }[];
  isError?: boolean;
  error?: { message: string };
}

async function lookup(rpc: ReturnType<typeof setup>["rpc"], token: string) {
  const lookedUp = await rpc(token, "tools/call", {
    name: "deepwiki__read_wiki_structure", arguments: { repoName: "facebook/react" },
  });
  expect(lookedUp._meta?.sessionId).toBeTruthy();
  const close = await rpc(token, "tools/call", { name: "end_session", arguments: { sessionId: lookedUp._meta?.sessionId } });
  expect(close.content?.map(({ type }) => type)).toEqual(["text"]);
  return {
    body: close.content?.[0]?.text,
    receipt: close.structuredContent?.receipt as { id: string; actions: unknown[]; changes: unknown[] },
    viewUrl: String(close.structuredContent?.viewUrl),
  };
}

function mockDeepWiki() {
  const upstream = vi.fn<typeof fetch>(async (_url, init) => {
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown };
    expect(init?.redirect).toBe("manual");
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    let result: Record<string, unknown> = { protocolVersion: "2025-03-26" };
    if (method === "tools/list") {
      result = { tools: [{ name: "read_wiki_structure", inputSchema: {
        type: "object", properties: { repoName: { type: "string" } }, required: ["repoName"],
      } }] };
    }
    if (method === "tools/call") {
      expect(params).toEqual({ name: "read_wiki_structure", arguments: { repoName: "facebook/react" } });
      result = { content: [{ type: "text", text: "Synthetic wiki outline" }] };
    }
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}
