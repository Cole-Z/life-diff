import { DEFAULT_SETTINGS, type UserSettings } from "../time";
import type {
  AbandonedSession,
  AccessVersions,
  CredentialRow,
  DailyDiffRow,
  ExpiredReceipt,
  ExpiredSnapshot,
  InstallationRow,
  MetadataStore,
  ObjectStore,
  ReceiptLocated,
  ReceiptMeta,
  ReceiptRow,
  SessionRow,
  UpstreamRecord,
} from "./types";

export class MemoryMetadataStore implements MetadataStore {
  users = new Map<string, { id: string; login: string; createdAt: string; updatedAt: string } & AccessVersions>();
  credentials = new Map<string, CredentialRow>();
  installations = new Map<string, InstallationRow[]>();
  sessions = new Map<string, SessionRow>();
  receipts = new Map<string, ReceiptRow>();
  upstreams = new Map<string, UpstreamRecord>();
  settings = new Map<string, UserSettings>();
  daily = new Map<string, DailyDiffRow>();

  async upsertUser(user: { id: string; login: string; now: string }): Promise<AccessVersions> {
    const existing = this.users.get(user.id);
    const accountVersion = existing?.accountVersion ?? crypto.randomUUID();
    const historyVersion = existing?.historyVersion ?? crypto.randomUUID();
    this.users.set(user.id, {
      id: user.id,
      login: user.login,
      createdAt: existing?.createdAt ?? user.now,
      updatedAt: user.now,
      accountVersion,
      historyVersion,
    });
    return { accountVersion, historyVersion };
  }

  async getAccessVersions(userId: string): Promise<AccessVersions | null> {
    const user = this.users.get(userId);
    return user ? { accountVersion: user.accountVersion, historyVersion: user.historyVersion } : null;
  }

  async saveCredentials(row: CredentialRow): Promise<void> {
    this.credentials.set(row.userId, { ...row });
  }

  async getCredentials(userId: string): Promise<CredentialRow | null> {
    const row = this.credentials.get(userId);
    return row ? { ...row } : null;
  }

  async replaceInstallations(userId: string, rows: InstallationRow[]): Promise<void> {
    this.installations.set(userId, rows.map((row) => ({ ...row })));
  }

  async insertSession(row: SessionRow): Promise<void> {
    this.sessions.set(row.id, { ...row });
  }

  async getSession(userId: string, sessionId: string): Promise<SessionRow | null> {
    const row = this.sessions.get(sessionId);
    if (!row || row.userId !== userId) return null;
    return { ...row };
  }

  async latestClosedSession(userId: string): Promise<SessionRow | null> {
    const rows = [...this.sessions.values()].filter((row) => row.userId === userId && row.status === "closed" && row.endedAt);
    rows.sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
    const row = rows[0];
    return row ? { ...row } : null;
  }

  async closeSession(input: { id: string; endedAt: string; receiptId: string; snapshotExpiresAt: string }): Promise<boolean> {
    const row = this.sessions.get(input.id);
    if (!row || row.status !== "open") return false;
    row.status = "closed";
    row.endedAt = input.endedAt;
    row.receiptId = input.receiptId;
    row.snapshotExpiresAt = input.snapshotExpiresAt;
    return true;
  }

  async insertReceipt(row: ReceiptRow): Promise<void> {
    this.receipts.set(row.id, { ...row });
  }

  async deleteReceipt(id: string): Promise<void> {
    this.receipts.delete(id);
  }

  async listReceipts(userId: string, limit: number): Promise<ReceiptMeta[]> {
    return [...this.receipts.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(toMeta);
  }

  async getReceipt(userId: string, receiptId: string): Promise<ReceiptMeta | null> {
    const row = this.receipts.get(receiptId);
    if (!row || row.userId !== userId) return null;
    return toMeta(row);
  }

  async findReceipt(receiptId: string): Promise<ReceiptLocated | null> {
    const row = this.receipts.get(receiptId);
    return row ? { ...toMeta(row), userId: row.userId } : null;
  }

  async listReceiptsSince(userId: string, since: string, limit: number): Promise<ReceiptMeta[]> {
    return [...this.receipts.values()]
      .filter((row) => row.userId === userId && row.createdAt >= since)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(toMeta);
  }

  async userObjectKeys(userId: string): Promise<string[]> {
    const keys: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.snapshotKey) keys.push(session.snapshotKey);
    }
    for (const receipt of this.receipts.values()) {
      if (receipt.userId === userId) keys.push(receipt.jsonKey, receipt.htmlKey, receipt.jsonKey.replace(/\.json$/, ".png"));
    }
    for (const row of this.daily.values()) {
      if (row.userId === userId) keys.push(row.jsonKey, row.htmlKey, ...(row.cardKey ? [row.cardKey] : []));
    }
    return keys;
  }

  async deleteUserRows(userId: string): Promise<void> {
    this.users.delete(userId);
    this.credentials.delete(userId);
    this.installations.delete(userId);
    for (const [id, row] of this.upstreams) if (row.userId === userId) this.upstreams.delete(id);
    for (const [id, session] of this.sessions) if (session.userId === userId) this.sessions.delete(id);
    for (const [id, receipt] of this.receipts) if (receipt.userId === userId) this.receipts.delete(id);
    this.settings.delete(userId);
    for (const [id, row] of this.daily) if (row.userId === userId) this.daily.delete(id);
  }

  async getSettings(userId: string): Promise<UserSettings> {
    return { ...(this.settings.get(userId) ?? DEFAULT_SETTINGS) };
  }

  async saveSettings(userId: string, settings: UserSettings, _now: string): Promise<void> {
    this.settings.set(userId, { ...settings });
  }

  async listUsers(): Promise<{ id: string; login: string }[]> {
    return [...this.users.values()].map((user) => ({ id: user.id, login: user.login }));
  }

  async listReceiptsBetween(userId: string, start: string, end: string, limit: number): Promise<ReceiptMeta[]> {
    return [...this.receipts.values()]
      .filter((row) => row.userId === userId && row.createdAt >= start && row.createdAt < end)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map(toMeta);
  }

  async getDaily(userId: string, day: string): Promise<DailyDiffRow | null> {
    const row = this.daily.get(`${userId}\0${day}`);
    return row ? { ...row } : null;
  }

  async listDaily(userId: string): Promise<DailyDiffRow[]> {
    return [...this.daily.values()].filter((row) => row.userId === userId).map((row) => ({ ...row }));
  }

  async saveDaily(row: DailyDiffRow): Promise<void> {
    this.daily.set(`${row.userId}\0${row.day}`, { ...row });
  }

  async clearHistory(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) user.historyVersion = crypto.randomUUID();
    for (const [id, session] of this.sessions) if (session.userId === userId) this.sessions.delete(id);
    for (const [id, receipt] of this.receipts) if (receipt.userId === userId) this.receipts.delete(id);
    for (const [id, row] of this.daily) if (row.userId === userId) this.daily.delete(id);
  }

  async expiredReceipts(nowIso: string, limit: number): Promise<ExpiredReceipt[]> {
    return [...this.receipts.values()]
      .filter((row) => row.expiresAt <= nowIso)
      .slice(0, limit)
      .map((row) => ({ id: row.id, jsonKey: row.jsonKey, htmlKey: row.htmlKey }));
  }

  async deleteReceipts(ids: string[]): Promise<void> {
    for (const id of ids) this.receipts.delete(id);
  }

  async expiredSnapshots(nowIso: string, limit: number): Promise<ExpiredSnapshot[]> {
    return [...this.sessions.values()]
      .filter((row) => row.snapshotKey && row.snapshotExpiresAt <= nowIso)
      .slice(0, limit)
      .map((row) => ({ sessionId: row.id, key: row.snapshotKey }));
  }

  async clearSnapshots(sessionIds: string[]): Promise<void> {
    for (const id of sessionIds) {
      const row = this.sessions.get(id);
      if (row) row.snapshotKey = "";
    }
  }

  async abandonedSessions(nowIso: string, limit: number): Promise<AbandonedSession[]> {
    return [...this.sessions.values()]
      .filter((row) => row.status === "open" && row.snapshotExpiresAt <= nowIso)
      .slice(0, limit)
      .map((row) => ({ userId: row.userId, sessionId: row.id, snapshotKey: row.snapshotKey || null }));
  }

  async deleteSessions(ids: string[]): Promise<void> {
    for (const id of ids) this.sessions.delete(id);
  }

  async listUpstreams(userId: string): Promise<UpstreamRecord[]> {
    return [...this.upstreams.values()]
      .filter((row) => row.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((row) => ({ ...row }));
  }

  async insertUpstream(row: UpstreamRecord): Promise<void> {
    this.upstreams.set(`${row.userId}\0${row.name}`, { ...row });
  }

  async deleteUpstream(userId: string, name: string): Promise<boolean> {
    return this.upstreams.delete(`${userId}\0${name}`);
  }
}

export class MemoryObjectStore implements ObjectStore {
  objects = new Map<string, { body: string; bytes?: Uint8Array; contentType: string }>();

  async put(key: string, body: string, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async putBytes(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: "", bytes: body, contentType });
  }

  async get(key: string): Promise<string | null> {
    const hit = this.objects.get(key);
    if (!hit || hit.bytes) return null;
    return hit.body;
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}

function toMeta(row: ReceiptRow): ReceiptMeta {
  return {
    id: row.id,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    jsonKey: row.jsonKey,
    htmlKey: row.htmlKey,
    added: row.added,
    removed: row.removed,
    modified: row.modified,
    verifiedClaims: row.verifiedClaims,
    missingClaims: row.missingClaims,
    unclaimedChanges: row.unclaimedChanges,
  };
}
