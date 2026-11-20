import type { UserSettings } from "../time";

export type { UserSettings };

export interface CredentialRow {
  userId: string;
  accessTokenEnc: string;
  refreshTokenEnc?: string;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  updatedAt: string;
}

export interface SessionRow {
  id: string;
  userId: string;
  startedAt: string;
  status: "open" | "closed";
  snapshotId: string;
  snapshotKey: string;
  snapshotExpiresAt: string;
  timeZone: string;
  repoCount: number;
  githubOptIn?: boolean;
  endedAt?: string;
  receiptId?: string;
}

export interface ReceiptRow {
  id: string;
  userId: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  jsonKey: string;
  htmlKey: string;
  added: number;
  removed: number;
  modified: number;
  verifiedClaims: number;
  missingClaims: number;
  unclaimedChanges: number;
}

export interface ReceiptMeta {
  id: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  jsonKey: string;
  htmlKey: string;
  added: number;
  removed: number;
  modified: number;
  verifiedClaims: number;
  missingClaims: number;
  unclaimedChanges: number;
}

export interface ReceiptLocated extends ReceiptMeta {
  userId: string;
}

export interface InstallationRow {
  installationId: number;
  accountLogin: string;
}

export interface ExpiredReceipt {
  id: string;
  jsonKey: string;
  htmlKey: string;
}

export interface ExpiredSnapshot {
  sessionId: string;
  key: string;
}

export interface AbandonedSession {
  userId: string;
  sessionId: string;
  snapshotKey: string | null;
}

export interface UpstreamRecord {
  id: string;
  userId: string;
  name: string;
  url: string;
  authEnc?: string;
  createdAt: string;
}

export interface DailyDiffRow {
  userId: string;
  day: string;
  finalizedAt?: string;
  jsonKey: string;
  htmlKey: string;
  cardKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MetadataStore {
  upsertUser(user: { id: string; login: string; now: string }): Promise<void>;
  saveCredentials(row: CredentialRow): Promise<void>;
  getCredentials(userId: string): Promise<CredentialRow | null>;
  replaceInstallations(userId: string, rows: InstallationRow[], now: string): Promise<void>;
  insertSession(row: SessionRow): Promise<void>;
  closeSession(input: { id: string; endedAt: string; receiptId: string; snapshotExpiresAt: string }): Promise<void>;
  insertReceipt(row: ReceiptRow): Promise<void>;
  listReceipts(userId: string, limit: number): Promise<ReceiptMeta[]>;
  listReceiptsSince(userId: string, since: string, limit: number): Promise<ReceiptMeta[]>;
  getReceipt(userId: string, receiptId: string): Promise<ReceiptMeta | null>;
  findReceipt(receiptId: string): Promise<ReceiptLocated | null>;
  userObjectKeys(userId: string): Promise<string[]>;
  deleteUserRows(userId: string): Promise<void>;
  expiredReceipts(nowIso: string, limit: number): Promise<ExpiredReceipt[]>;
  deleteReceipts(ids: string[]): Promise<void>;
  expiredSnapshots(nowIso: string, limit: number): Promise<ExpiredSnapshot[]>;
  clearSnapshots(sessionIds: string[]): Promise<void>;
  abandonedSessions(nowIso: string, limit: number): Promise<AbandonedSession[]>;
  deleteSessions(ids: string[]): Promise<void>;
  listUpstreams(userId: string): Promise<UpstreamRecord[]>;
  insertUpstream(row: UpstreamRecord): Promise<void>;
  deleteUpstream(userId: string, name: string): Promise<boolean>;
  getSettings(userId: string): Promise<UserSettings>;
  saveSettings(userId: string, settings: UserSettings, now: string): Promise<void>;
  listUsers(): Promise<{ id: string; login: string }[]>;
  listReceiptsBetween(userId: string, start: string, end: string, limit: number): Promise<ReceiptMeta[]>;
  getDaily(userId: string, day: string): Promise<DailyDiffRow | null>;
  listDaily(userId: string): Promise<DailyDiffRow[]>;
  saveDaily(row: DailyDiffRow): Promise<void>;
  clearHistory(userId: string): Promise<void>;
}

export interface ObjectStore {
  put(key: string, body: string, contentType: string): Promise<void>;
  putBytes(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<string | null>;
  getBytes(key: string): Promise<Uint8Array | null>;
  delete(keys: string[]): Promise<void>;
}
