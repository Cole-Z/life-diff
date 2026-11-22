import { AppError } from "../app/service";
import { encryptString, decryptString } from "../crypto/aesgcm";
import { newId } from "../text";
import type { MetadataStore, UpstreamRecord } from "../storage/types";
import type { UpstreamAuth, UpstreamTarget } from "./client";
import { approvedUpstreamUrl, validateUpstreamName, validUpstreamAuthHeader } from "./namespace";

export type UpstreamPublic = {
  name: string;
  hasToken: boolean;
  createdAt: string;
} & ({ status: "approved"; url: string } | { status: "blocked" });

export interface UpstreamInput {
  name: string;
  url: string;
  token?: string;
  header?: string;
}

const MAX_UPSTREAMS = 20;

export async function listPublicUpstreams(meta: MetadataStore, userId: string, endpoints: ReadonlySet<string>): Promise<UpstreamPublic[]> {
  const rows = await meta.listUpstreams(userId);
  return rows.map((row) => toPublic(row, endpoints));
}

export async function addUpstream(meta: MetadataStore, userId: string, key: string, now: Date, endpoints: ReadonlySet<string>, input: UpstreamInput): Promise<Extract<UpstreamPublic, { status: "approved" }>> {
  let name: string;
  try {
    name = validateUpstreamName(input.name);
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "That upstream is not valid.");
  }
  const url = approvedUpstreamUrl(input.url, endpoints);
  if (!url) throw new AppError("Use an approved final HTTPS endpoint without embedded credentials, a query, or a fragment. Put credentials in the token field.");
  const token = input.token?.trim() ?? "";
  if (/[\r\n]/.test(token)) throw new AppError("Token cannot contain a newline.");
  if (token.length > 2000) throw new AppError("Token is too long.");
  let header = "Authorization";
  if (input.header?.trim()) {
    header = input.header.trim();
    if (!validUpstreamAuthHeader(header)) throw new AppError("Provide a valid upstream authentication header.");
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
  return { ...publicFields(row), status: "approved", url };
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

export async function loadTargets(meta: MetadataStore, userId: string, key: string, endpoints: ReadonlySet<string>): Promise<UpstreamTarget[]> {
  const rows = await meta.listUpstreams(userId);
  const targets: UpstreamTarget[] = [];
  for (const row of rows) {
    const url = approvedUpstreamUrl(row.url, endpoints);
    if (!url) continue;
    const auth = await readAuth(key, row.authEnc);
    if (row.authEnc && !auth) continue;
    targets.push({ name: row.name, url, ...(auth ? { auth } : {}) });
  }
  return targets;
}

async function readAuth(key: string, sealed: string | undefined): Promise<UpstreamAuth | undefined> {
  if (!sealed) return undefined;
  try {
    const parsed = JSON.parse(await decryptString(key, sealed)) as { header?: unknown; value?: unknown };
    if (typeof parsed.header !== "string" || !validUpstreamAuthHeader(parsed.header) || typeof parsed.value !== "string" || !parsed.value) return undefined;
    return { header: parsed.header, value: parsed.value };
  } catch {
    return undefined;
  }
}

function toPublic(row: UpstreamRecord, endpoints: ReadonlySet<string>): UpstreamPublic {
  const fields = publicFields(row);
  const url = approvedUpstreamUrl(row.url, endpoints);
  return url ? { ...fields, url, status: "approved" } : { ...fields, status: "blocked" };
}

function publicFields(row: UpstreamRecord) {
  return { name: row.name, hasToken: Boolean(row.authEnc), createdAt: row.createdAt };
}
