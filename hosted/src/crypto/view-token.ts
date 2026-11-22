import { base64UrlToBytes, bytesToBase64Url, timingSafeEqual } from "../text";

/** Signed HTML links expire after a day. They open one receipt or one day, and nothing else. */
export const VIEW_TTL_SECONDS = 24 * 60 * 60;

export interface ViewGrant {
  kind: "receipt" | "day";
  id: string;
  userId: string;
  historyVersion: string;
  exp: number;
}

export async function signViewGrant(key: string, grant: Omit<ViewGrant, "exp">, nowSeconds: number): Promise<string> {
  assertKey(key);
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    kind: grant.kind,
    id: grant.id,
    userId: grant.userId,
    historyVersion: grant.historyVersion,
    exp: nowSeconds + VIEW_TTL_SECONDS,
  } satisfies ViewGrant)));
  const sig = await hmac(key, body);
  return `${body}.${sig}`;
}

export async function readViewGrant(key: string, token: string, nowSeconds: number): Promise<ViewGrant | null> {
  if (key.trim().length < 32) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(key, body);
  const got = base64UrlToBytes(sig);
  const want = base64UrlToBytes(expected);
  if (!timingSafeEqual(got, want)) return null;
  let parsed: ViewGrant;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as ViewGrant;
  } catch {
    return null;
  }
  if (!parsed || (parsed.kind !== "receipt" && parsed.kind !== "day")) return null;
  if (typeof parsed.id !== "string" || !parsed.id || typeof parsed.userId !== "string" || !parsed.userId) return null;
  if (typeof parsed.historyVersion !== "string") return null;
  if (typeof parsed.exp !== "number" || parsed.exp <= nowSeconds) return null;
  return parsed;
}

export function viewUrl(origin: string, kind: ViewGrant["kind"], id: string, token: string): string {
  const path = kind === "receipt" ? `/receipts/${encodeURIComponent(id)}` : `/roundup/${encodeURIComponent(id)}`;
  return `${origin.replace(/\/$/, "")}${path}?t=${encodeURIComponent(token)}`;
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
