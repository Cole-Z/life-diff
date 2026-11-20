import { encryptString, decryptString } from "../crypto/aesgcm";
import { AppError } from "../app/service";
import { newId } from "../text";
import type { MetadataStore, UpstreamPublic, UpstreamRow, UpstreamSecret } from "../storage/types";

const NAME = /^[a-z][a-z0-9-]{0,24}$/;
const MAX_UPSTREAMS = 8;

export function validateUpstreamName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!NAME.test(trimmed)) {
    throw new AppError("Name must start with a letter and use only lowercase letters, numbers, and dashes (24 characters at most).");
  }
  return trimmed;
}

export function validateUpstreamUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError("URL must be an https address of an MCP server.");
  }
  if (url.username || url.password) throw new AppError("Put the token in the token field, not in the URL.");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && loopback) return url.toString();
  if (url.protocol !== "https:") throw new AppError("URL must start with https://.");
  if (trimmed.length > 500) throw new AppError("URL is too long.");
  return url.toString();
}

export async function addUpstream(
  meta: MetadataStore,
  key: string,
  userId: string,
  now: Date,
  input: { name: string; url: string; token?: string },
): Promise<UpstreamPublic> {
  const name = validateUpstreamName(input.name);
  const url = validateUpstreamUrl(input.url);
  const existing = await meta.listUpstreams(userId);
  if (existing.length >= MAX_UPSTREAMS) throw new AppError(`You can register ${MAX_UPSTREAMS} upstream servers.`);
  if (existing.some((row) => row.name === name)) throw new AppError(`An upstream named ${name} is already registered.`);
  const token = input.token?.trim() ?? "";
  if (token.length > 2000) throw new AppError("Token is too long.");
  const row: UpstreamRow = {
    id: newId("up", now),
    userId,
    name,
    url,
    createdAt: now.toISOString(),
    ...(token ? { tokenEnc: await encryptString(key, token) } : {}),
  };
  await meta.insertUpstream(row);
  return publicUpstream(row);
}

export async function listUpstreamPublic(meta: MetadataStore, userId: string): Promise<UpstreamPublic[]> {
  const rows = await meta.listUpstreams(userId);
  return rows.map(publicUpstream);
}

export async function removeUpstream(meta: MetadataStore, userId: string, name: string): Promise<void> {
  const validated = validateUpstreamName(name);
  const removed = await meta.deleteUpstream(userId, validated);
  if (!removed) throw new AppError(`No upstream named ${validated}.`);
}

export async function loadUpstreamSecrets(meta: MetadataStore, key: string, userId: string): Promise<UpstreamSecret[]> {
  const rows = await meta.listUpstreams(userId);
  const secrets: UpstreamSecret[] = [];
  for (const row of rows) {
    if (!row.tokenEnc) {
      secrets.push({ name: row.name, url: row.url, createdAt: row.createdAt });
      continue;
    }
    try {
      secrets.push({ name: row.name, url: row.url, createdAt: row.createdAt, token: await decryptString(key, row.tokenEnc) });
    } catch {
      secrets.push({ name: row.name, url: row.url, createdAt: row.createdAt, tokenUnreadable: true });
    }
  }
  return secrets;
}

function publicUpstream(row: UpstreamRow): UpstreamPublic {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    hasToken: Boolean(row.tokenEnc),
    createdAt: row.createdAt,
  };
}
