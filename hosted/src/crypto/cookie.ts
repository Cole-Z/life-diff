import { base64UrlToBytes, bytesToBase64Url, timingSafeEqual } from "../text";

export interface SessionCookie {
  sub: string;
  login: string;
  csrf: string;
  exp: number;
}

const COOKIE_NAME = "__Host-lifediff";

export async function signSession(key: string, payload: SessionCookie): Promise<string> {
  assertKey(key);
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(key, body);
  return `${body}.${sig}`;
}

export async function readSession(key: string, token: string, nowSeconds: number): Promise<SessionCookie | null> {
  assertKey(key);
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(key, body);
  const got = base64UrlToBytes(sig);
  const want = base64UrlToBytes(expected);
  if (!timingSafeEqual(got, want)) return null;
  let parsed: SessionCookie;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as SessionCookie;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.sub !== "string" || typeof parsed.login !== "string" || typeof parsed.csrf !== "string") {
    return null;
  }
  if (typeof parsed.exp !== "number" || parsed.exp <= nowSeconds) return null;
  return parsed;
}

export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readCookie(header: string | null, name = COOKIE_NAME): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

async function hmac(key: string, body: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(body));
  return bytesToBase64Url(new Uint8Array(sig));
}

function assertKey(key: string): void {
  if (key.trim().length < 32) throw new Error("COOKIE_SIGNING_KEY must be at least 32 characters");
}
