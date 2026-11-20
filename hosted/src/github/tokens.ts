import { bindFetch } from "../bind-fetch";
import { decryptString, encryptString } from "../crypto/aesgcm";
import { refreshGithubToken } from "./oauth";
import type { CredentialRow, MetadataStore } from "../storage/types";

const EXPIRY_SKEW_MS = 60 * 1000;

export async function loadAccessToken(input: {
  meta: MetadataStore;
  userId: string;
  key: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<string> {
  const row = await input.meta.getCredentials(input.userId);
  if (!row) throw new Error("GitHub is not connected. Sign in again.");
  const now = input.now ?? new Date();
  const access = await decryptString(input.key, row.accessTokenEnc);
  if (!expired(row.accessExpiresAt, now)) return access;
  if (!row.refreshTokenEnc) throw new Error("GitHub access expired. Sign in again.");
  const refreshToken = await decryptString(input.key, row.refreshTokenEnc);
  let refreshed;
  try {
    refreshed = await refreshGithubToken(bindFetch(input.fetchImpl ?? globalThis.fetch), {
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken,
    });
  } catch {
    throw new Error("GitHub access could not be refreshed. Sign in again.");
  }
  await input.meta.saveCredentials(await sealCredentials(input.key, input.userId, refreshed, now));
  return refreshed.accessToken;
}

export async function sealCredentials(key: string, userId: string, tokens: {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
}, now: Date): Promise<CredentialRow> {
  return {
    userId,
    accessTokenEnc: await encryptString(key, tokens.accessToken),
    ...(tokens.refreshToken ? { refreshTokenEnc: await encryptString(key, tokens.refreshToken) } : {}),
    ...(tokens.accessExpiresAt ? { accessExpiresAt: tokens.accessExpiresAt } : {}),
    ...(tokens.refreshExpiresAt ? { refreshExpiresAt: tokens.refreshExpiresAt } : {}),
    updatedAt: now.toISOString(),
  };
}

function expired(iso: string | undefined, now: Date): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return true;
  return time <= now.getTime() + EXPIRY_SKEW_MS;
}
