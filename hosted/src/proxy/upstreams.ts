import { AppError } from "../app/service";
import { encryptString, decryptString } from "../crypto/aesgcm";
import { newId } from "../text";
import type { MetadataStore, UpstreamRecord } from "../storage/types";
import type { UpstreamAuth, UpstreamTarget } from "./client";
import { validateUpstreamName, validateUpstreamUrl } from "./namespace";

export interface UpstreamPublic {
  name: string;
  url: string;
  hasToken: boolean;
  createdAt: string;
}

export interface UpstreamInput {
  name: string;
  url: string;
  token?: string;
  header?: string;
}

const MAX_UPSTREAMS = 20;

export async function listPublicUpstreams(meta: MetadataStore, userId: string): Promise<UpstreamPublic[]> {
  const rows = await meta.listUpstreams(userId);
  return rows.map(toPublic);
}

export async function addUpstream(meta: MetadataStore, userId: string, key: string, now: Date, input: UpstreamInput): Promise<UpstreamPublic> {
  let name: string;
  let url: string;
  try {
    name = validateUpstreamName(input.name);
    url = validateUpstreamUrl(input.url);
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "That upstream is not valid.");
  }
  const token = input.token?.trim() ?? "";
  if (/[\r\n]/.test(token)) throw new AppError("Token cannot contain a newline.");
  if (token.length > 2000) throw new AppError("Token is too long.");
  let header = "Authorization";
  if (input.header?.trim()) {
    header = input.header.trim();
    if (!/^[A-Za-z0-9-]{1,40}$/.test(header)) throw new AppError("Header name must be letters, numbers, or dashes.");
  }
  const existing = await meta.listUpstreams(userId);
  if (existing.some((row) => row.name === name)) {
    throw new AppError(`An upstream named ${name} is already registered. Remove it before adding it again.`);
  }
  if (existing.length >= MAX_UPSTREAMS) throw new AppError(`Life Diff keeps at most ${MAX_UPSTREAMS} upstreams.`);
  let authEnc: string | undefined;
  if (token) {
    const value = header.toLowerCase() === "authorization" && !/^Bearer\s+/i.test(token) ? `Bearer ${token}` : token;
    authEnc = await encryptString(key, JSON.stringify({ header, value }));
  }
  const row: UpstreamRecord = {
    id: newId("up", now),
    userId,
    name,
    url,
    createdAt: now.toISOString(),
    ...(authEnc ? { authEnc } : {}),
  };
  await meta.insertUpstream(row);
  return toPublic(row);
}

export async function removeUpstream(meta: MetadataStore, userId: string, name: string): Promise<void> {
  let validated: string;
  try {
    validated = validateUpstreamName(name);
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "That name is not valid.");
  }
  const removed = await meta.deleteUpstream(userId, validated);
  if (!removed) throw new AppError(`No upstream named ${validated}.`);
}

export async function loadTargets(meta: MetadataStore, userId: string, key: string): Promise<UpstreamTarget[]> {
  const rows = await meta.listUpstreams(userId);
  const targets: UpstreamTarget[] = [];
  for (const row of rows) {
    const auth = await readAuth(key, row.authEnc);
    targets.push({ name: row.name, url: row.url, ...(auth ? { auth } : {}) });
  }
  return targets;
}

async function readAuth(key: string, sealed: string | undefined): Promise<UpstreamAuth | undefined> {
  if (!sealed) return undefined;
  try {
    const parsed = JSON.parse(await decryptString(key, sealed)) as { header?: unknown; value?: unknown };
    if (typeof parsed.header !== "string" || typeof parsed.value !== "string" || !parsed.value) return undefined;
    return { header: parsed.header, value: parsed.value };
  } catch {
    return undefined;
  }
}

function toPublic(row: UpstreamRecord): UpstreamPublic {
  return { name: row.name, url: row.url, hasToken: Boolean(row.authEnc), createdAt: row.createdAt };
}
