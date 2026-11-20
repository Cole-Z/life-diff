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
} from "./types";

interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
}

export interface Sql {
  prepare(query: string): SqlStatement;
}

export class D1MetadataStore implements MetadataStore {
  constructor(private readonly db: Sql) {}

  async upsertUser(user: { id: string; login: string; now: string }): Promise<void> {
    await this.db.prepare(
      `INSERT INTO users (id, login, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET login = excluded.login, updated_at = excluded.updated_at`,
    ).bind(user.id, user.login, user.now, user.now).run();
  }

  async saveCredentials(row: CredentialRow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO github_credentials (user_id, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         access_expires_at = excluded.access_expires_at,
         refresh_expires_at = excluded.refresh_expires_at,
         updated_at = excluded.updated_at`,
    ).bind(row.userId, row.accessTokenEnc, row.refreshTokenEnc ?? null, row.accessExpiresAt ?? null, row.refreshExpiresAt ?? null, row.updatedAt).run();
  }

  async getCredentials(userId: string): Promise<CredentialRow | null> {
    const row = await this.db.prepare(
      `SELECT user_id, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, updated_at
       FROM github_credentials WHERE user_id = ?`,
    ).bind(userId).first<CredentialSql>();
    if (!row) return null;
    return {
      userId: row.user_id,
      accessTokenEnc: row.access_token_enc,
      ...(row.refresh_token_enc ? { refreshTokenEnc: row.refresh_token_enc } : {}),
      ...(row.access_expires_at ? { accessExpiresAt: row.access_expires_at } : {}),
      ...(row.refresh_expires_at ? { refreshExpiresAt: row.refresh_expires_at } : {}),
      updatedAt: row.updated_at,
    };
  }

  async replaceInstallations(userId: string, rows: InstallationRow[], now: string): Promise<void> {
    await this.db.prepare(`DELETE FROM installations WHERE user_id = ?`).bind(userId).run();
    for (const row of rows) {
      await this.db.prepare(
        `INSERT INTO installations (user_id, installation_id, account_login, updated_at) VALUES (?, ?, ?, ?)`,
      ).bind(userId, row.installationId, row.accountLogin, now).run();
    }
  }

  async insertSession(row: SessionRow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO sessions (id, user_id, started_at, ended_at, status, snapshot_id, snapshot_r2_key, snapshot_expires_at, receipt_id, time_zone, repo_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.id, row.userId, row.startedAt, row.endedAt ?? null, row.status, row.snapshotId, row.snapshotKey, row.snapshotExpiresAt, row.receiptId ?? null, row.timeZone, row.repoCount).run();
  }

  async closeSession(input: { id: string; endedAt: string; receiptId: string; snapshotExpiresAt: string }): Promise<void> {
    await this.db.prepare(
      `UPDATE sessions SET status = 'closed', ended_at = ?, receipt_id = ?, snapshot_expires_at = ? WHERE id = ?`,
    ).bind(input.endedAt, input.receiptId, input.snapshotExpiresAt, input.id).run();
  }

  async insertReceipt(row: ReceiptRow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO receipts (id, user_id, session_id, created_at, expires_at, json_r2_key, html_r2_key, added, removed, modified, verified_claims, missing_claims, unclaimed_changes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.id, row.userId, row.sessionId, row.createdAt, row.expiresAt, row.jsonKey, row.htmlKey, row.added, row.removed, row.modified, row.verifiedClaims, row.missingClaims, row.unclaimedChanges).run();
  }

  async listReceipts(userId: string, limit: number): Promise<ReceiptMeta[]> {
    const rows = await this.db.prepare(
      `SELECT id, session_id, created_at, expires_at, json_r2_key, html_r2_key, added, removed, modified, verified_claims, missing_claims, unclaimed_changes
       FROM receipts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).bind(userId, limit).all<ReceiptSql>();
    return rows.results.map(receiptMeta);
  }

  async getReceipt(userId: string, receiptId: string): Promise<ReceiptMeta | null> {
    const row = await this.db.prepare(
      `SELECT id, session_id, created_at, expires_at, json_r2_key, html_r2_key, added, removed, modified, verified_claims, missing_claims, unclaimed_changes
       FROM receipts WHERE user_id = ? AND id = ?`,
    ).bind(userId, receiptId).first<ReceiptSql>();
    return row ? receiptMeta(row) : null;
  }

  async userObjectKeys(userId: string): Promise<string[]> {
    const snapshots = await this.db.prepare(
      `SELECT snapshot_r2_key FROM sessions WHERE user_id = ? AND snapshot_r2_key IS NOT NULL AND snapshot_r2_key != ''`,
    ).bind(userId).all<{ snapshot_r2_key: string }>();
    const receipts = await this.db.prepare(
      `SELECT json_r2_key, html_r2_key FROM receipts WHERE user_id = ?`,
    ).bind(userId).all<{ json_r2_key: string; html_r2_key: string }>();
    return [
      ...snapshots.results.map((row) => row.snapshot_r2_key),
      ...receipts.results.flatMap((row) => [row.json_r2_key, row.html_r2_key]),
    ];
  }

  async deleteUserRows(userId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM receipts WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM installations WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM github_credentials WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
  }

  async expiredReceipts(nowIso: string, limit: number): Promise<ExpiredReceipt[]> {
    const rows = await this.db.prepare(
      `SELECT id, json_r2_key, html_r2_key FROM receipts WHERE expires_at <= ? ORDER BY expires_at LIMIT ?`,
    ).bind(nowIso, limit).all<{ id: string; json_r2_key: string; html_r2_key: string }>();
    return rows.results.map((row) => ({ id: row.id, jsonKey: row.json_r2_key, htmlKey: row.html_r2_key }));
  }

  async deleteReceipts(ids: string[]): Promise<void> {
    for (const id of ids) await this.db.prepare(`DELETE FROM receipts WHERE id = ?`).bind(id).run();
  }

  async expiredSnapshots(nowIso: string, limit: number): Promise<ExpiredSnapshot[]> {
    const rows = await this.db.prepare(
      `SELECT id, snapshot_r2_key FROM sessions
       WHERE snapshot_r2_key IS NOT NULL AND snapshot_r2_key != '' AND snapshot_expires_at <= ?
       ORDER BY snapshot_expires_at LIMIT ?`,
    ).bind(nowIso, limit).all<{ id: string; snapshot_r2_key: string }>();
    return rows.results.map((row) => ({ sessionId: row.id, key: row.snapshot_r2_key }));
  }

  async clearSnapshots(sessionIds: string[]): Promise<void> {
    for (const id of sessionIds) {
      await this.db.prepare(`UPDATE sessions SET snapshot_r2_key = '' WHERE id = ?`).bind(id).run();
    }
  }

  async abandonedSessions(nowIso: string, limit: number): Promise<AbandonedSession[]> {
    const rows = await this.db.prepare(
      `SELECT user_id, id, snapshot_r2_key FROM sessions
       WHERE status = 'open' AND snapshot_expires_at <= ? ORDER BY snapshot_expires_at LIMIT ?`,
    ).bind(nowIso, limit).all<{ user_id: string; id: string; snapshot_r2_key: string | null }>();
    return rows.results.map((row) => ({
      userId: row.user_id,
      sessionId: row.id,
      snapshotKey: row.snapshot_r2_key || null,
    }));
  }

  async deleteSessions(ids: string[]): Promise<void> {
    for (const id of ids) await this.db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
  }
}

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: string, contentType: string): Promise<void> {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
  }

  async get(key: string): Promise<string | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return object.text();
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.bucket.delete(keys);
  }
}

interface CredentialSql {
  user_id: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  updated_at: string;
}

interface ReceiptSql {
  id: string;
  session_id: string;
  created_at: string;
  expires_at: string;
  json_r2_key: string;
  html_r2_key: string;
  added: number;
  removed: number;
  modified: number;
  verified_claims: number;
  missing_claims: number;
  unclaimed_changes: number;
}

function receiptMeta(row: ReceiptSql): ReceiptMeta {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    jsonKey: row.json_r2_key,
    htmlKey: row.html_r2_key,
    added: row.added,
    removed: row.removed,
    modified: row.modified,
    verifiedClaims: row.verified_claims,
    missingClaims: row.missing_claims,
    unclaimedChanges: row.unclaimed_changes,
  };
}
