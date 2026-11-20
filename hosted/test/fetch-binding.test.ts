import { afterEach, describe, expect, it, vi } from "vitest";
import { githubForToken } from "../src/app/service";
import { GitHubClient } from "../src/github/client";
import { loadAccessToken, sealCredentials } from "../src/github/tokens";
import { MemoryMetadataStore } from "../src/storage/memory";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workers fetch receiver", () => {
  it("rejects a fetch stored on an object and called as a method", async () => {
    const holder = { fetch: workersFetch };
    await expect(holder.fetch("https://api.github.com/user/installations")).rejects.toThrow(/Illegal invocation/);
  });

  it("calls the default GitHub fetch with globalThis as this", async () => {
    vi.stubGlobal("fetch", workersFetch);
    const api = githubForToken("ghu_test_token");
    await expect(api.listInstallations()).resolves.toEqual([{ id: 1, accountLogin: "acme" }]);
  });

  it("calls an injected GitHub fetch with globalThis as this", async () => {
    const client = new GitHubClient({ token: "ghu_test_token", fetch: workersFetch });
    await expect(client.listInstallations()).resolves.toEqual([{ id: 1, accountLogin: "acme" }]);
  });

  it("refreshes a GitHub token through the default fetch", async () => {
    vi.stubGlobal("fetch", workersFetch);
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const meta = new MemoryMetadataStore();
    await meta.saveCredentials(await sealCredentials(key, "42", {
      accessToken: "ghu_old",
      refreshToken: "ghr_old",
      accessExpiresAt: "2020-01-01T00:00:00.000Z",
    }, new Date("2020-01-01T00:00:00.000Z")));
    const token = await loadAccessToken({
      meta,
      userId: "42",
      key,
      clientId: "client",
      clientSecret: "secret",
      now: new Date("2026-04-02T15:00:00.000Z"),
    });
    expect(token).toBe("ghu_new");
  });
});

function workersFetch(this: unknown, input: RequestInfo | URL): Promise<Response> {
  if (this !== globalThis) {
    return Promise.reject(new TypeError("Illegal invocation: function called with incorrect `this` reference"));
  }
  const url = input instanceof URL ? input : new URL(String(input));
  if (url.origin === "https://api.github.com" && url.pathname === "/user/installations") {
    return Promise.resolve(Response.json({ installations: [{ id: 1, account: { login: "acme", type: "User" } }] }));
  }
  if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
    return Promise.resolve(Response.json({ access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 3600 }));
  }
  return Promise.resolve(new Response("no", { status: 404 }));
}
