import { describe, expect, it } from "vitest";
import { decryptString, encryptString } from "../src/crypto/aesgcm";
import { readCookie, readSession, signSession } from "../src/crypto/cookie";
import { codeChallengeS256 } from "../src/crypto/pkce";
import { authProps, githubAuthorizeUrl } from "../src/github/oauth";

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

describe("AES-GCM", () => {
  it("round-trips a token and does not store it in the clear", async () => {
    const token = "ghu_example_token_value";
    const sealed = await encryptString(KEY, token);
    expect(sealed).not.toContain(token);
    expect(await decryptString(KEY, sealed)).toBe(token);
    const again = await encryptString(KEY, token);
    expect(again).not.toBe(sealed);
  });

  it("rejects a tampered ciphertext and the wrong key", async () => {
    const sealed = await encryptString(KEY, "secret");
    const [iv, cipher] = sealed.split(".");
    await expect(decryptString(KEY, `${iv}.${cipher?.slice(0, -2)}aa`)).rejects.toThrow(/could not be opened/);
    const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    await expect(decryptString(other, sealed)).rejects.toThrow(/could not be opened/);
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(encryptString(Buffer.from("short").toString("base64"), "x")).rejects.toThrow(/32 bytes/);
  });
});

describe("session cookie", () => {
  const signing = "cookie-signing-key-that-is-long-enough";

  it("round-trips and rejects tampering and expiry", async () => {
    const token = await signSession(signing, { sub: "42", login: "octocat", csrf: "csrf-1", exp: 2_000 });
    expect(await readSession(signing, token, 1_000)).toMatchObject({ sub: "42", login: "octocat" });
    expect(await readSession(signing, token, 2_000)).toBeNull();
    expect(await readSession(signing, `${token}x`, 1_000)).toBeNull();
    const [body] = token.split(".");
    expect(await readSession(signing, `${body}.aaaa`, 1_000)).toBeNull();
  });

  it("reads the host cookie and ignores others", () => {
    expect(readCookie("__Host-lifediff=abc; theme=dark")).toBe("abc");
    expect(readCookie("theme=dark")).toBeNull();
  });
});

describe("GitHub OAuth helpers", () => {
  it("builds an authorize URL without the client secret", () => {
    const url = new URL(githubAuthorizeUrl({
      clientId: "Iv1.client",
      redirectUri: "https://lifediff.dev/callback",
      state: "state-1",
      codeChallenge: "challenge",
    }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://lifediff.dev/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(url.search).not.toContain("ghu_");
  });

  it("puts only the user id and login on the MCP grant", () => {
    const props = authProps({ id: 7, login: "octocat" });
    expect(props).toEqual({ userId: "7", login: "octocat" });
    expect(Object.keys(props).sort()).toEqual(["login", "userId"]);
  });

  it("uses S256 for the code challenge", async () => {
    const challenge = await codeChallengeS256("verifier");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain("verifier");
  });
});
