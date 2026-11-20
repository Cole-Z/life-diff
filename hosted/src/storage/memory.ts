import type {
  AbandonedSession,
  CredentialRow,
  ExpiredReceipt,
  ExpiredSnapshot,
  InstallationRow,
  MetadataStore,
  ObjectStore,
  ReceiptMeta,
  ReceiptRow,
  SessionRow,
  UpstreamRecord,
} from "./types";

export class MemoryMetadataStore implements MetadataStore {
  users = new Map<string, { id: string; login: string; createdAt: string; updatedAt: string }>();
  credentials = new Map<string, CredentialRow>();
  installations = new Map<string, InstallationRow[]>();
  sessions = new Map<string, SessionRow>();
  receipts = new Map<string, ReceiptRow>();
  upstreams = new Map<string, UpstreamRecord>();

  async upsertUser(user: { id: string; login: string; now: string }): Promise<void> {
    const existing = this.users.get(user.id);
    this.users.set(user.id, {
      id: user.id,
      login: user.login,
      createdAt: existing?.createdAt ?? user.now,
      updatedAt: user.now,
    });
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

  async closeSession(input: { id: string; endedAt: string; receiptId: string; snapshotExpiresAt: string }): Promise<void> {
    const row = this.sessions.get(input.id);
    if (!row) return;
    row.status = "closed";
    row.endedAt = input.endedAt;
    row.receiptId = input.receiptId;
    row.snapshotExpiresAt = input.snapshotExpiresAt;
  }

  async insertReceipt(row: ReceiptRow): Promise<void> {
    this.receipts.set(row.id, { ...row });
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

  async userObjectKeys(userId: string): Promise<string[]> {
    const keys: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.snapshotKey) keys.push(session.snapshotKey);
    }
    for (const receipt of this.receipts.values()) {
      if (receipt.userId === userId) keys.push(receipt.jsonKey, receipt.htmlKey);
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
  objects = new Map<string, { body: string; contentType: string }>();

  async put(key: string, body: string, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async get(key: string): Promise<string | null> {
    return this.objects.get(key)?.body ?? null;
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
