import { validTimeZone } from "../text";
import { DEFAULT_SETTINGS, parseDayEnd, type UserSettings } from "../time";
import type {
  AbandonedSession,
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
      `INSERT INTO sessions (id, user_id, started_at, ended_at, status, snapshot_id, snapshot_r2_key, snapshot_expires_at, receipt_id, time_zone, repo_count, github_opt_in)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.id, row.userId, row.startedAt, row.endedAt ?? null, row.status, row.snapshotId, row.snapshotKey, row.snapshotExpiresAt, row.receiptId ?? null, row.timeZone, row.repoCount, row.githubOptIn ? 1 : 0).run();
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

  async listReceiptsSince(userId: string, since: string, limit: number): Promise<ReceiptMeta[]> {
    const rows = await this.db.prepare(
      `SELECT id, session_id, created_at, expires_at, json_r2_key, html_r2_key, added, removed, modified, verified_claims, missing_claims, unclaimed_changes
       FROM receipts WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
    ).bind(userId, since, limit).all<ReceiptSql>();
    return rows.results.map(receiptMeta);
  }

  async getReceipt(userId: string, receiptId: string): Promise<ReceiptMeta | null> {
    const row = await this.db.prepare(
      `SELECT id, session_id, created_at, expires_at, json_r2_key, html_r2_key, added, removed, modified, verified_claims, missing_claims, unclaimed_changes
       FROM receipts WHERE user_id = ? AND id = ?`,
    ).bind(userId, receiptId).first<ReceiptSql>();
    return row ? receiptMeta(row) : null;
  }

  async findReceipt(receiptId: string): Promise<ReceiptLocated | null> {
    const row = await this.db.prepare(
      `SELECT id, user_id, session_id, created_at, expires_at, json_r2_key, html_r2_key, added, removed, modified, verified_claims, missing_claims, unclaimed_changes
       FROM receipts WHERE id = ?`,
    ).bind(receiptId).first<ReceiptSql & { user_id: string }>();
    return row ? { ...receiptMeta(row), userId: row.user_id } : null;
  }

  async userObjectKeys(userId: string): Promise<string[]> {
    const snapshots = await this.db.prepare(
      `SELECT snapshot_r2_key FROM sessions WHERE user_id = ? AND snapshot_r2_key IS NOT NULL AND snapshot_r2_key != ''`,
    ).bind(userId).all<{ snapshot_r2_key: string }>();
    const receipts = await this.db.prepare(
      `SELECT json_r2_key, html_r2_key FROM receipts WHERE user_id = ?`,
    ).bind(userId).all<{ json_r2_key: string; html_r2_key: string }>();
    const days = await this.db.prepare(
      `SELECT json_r2_key, html_r2_key, card_r2_key FROM daily_diffs WHERE user_id = ?`,
    ).bind(userId).all<{ json_r2_key: string; html_r2_key: string; card_r2_key: string | null }>();
    return [
      ...snapshots.results.map((row) => row.snapshot_r2_key),
      ...receipts.results.flatMap((row) => [row.json_r2_key, row.html_r2_key, row.json_r2_key.replace(/\.json$/, ".png")]),
      ...days.results.flatMap((row) => [row.json_r2_key, row.html_r2_key, ...(row.card_r2_key ? [row.card_r2_key] : [])]),
    ];
  }

  async deleteUserRows(userId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM receipts WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM installations WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM github_credentials WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM upstreams WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM user_settings WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM daily_diffs WHERE user_id = ?`).bind(userId).run();
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

  async listUpstreams(userId: string): Promise<UpstreamRecord[]> {
    const rows = await this.db.prepare(
      `SELECT id, user_id, name, url, auth_enc, created_at FROM upstreams WHERE user_id = ? ORDER BY created_at ASC`,
    ).bind(userId).all<UpstreamSql>();
    return rows.results.map(upstreamRecord);
  }

  async insertUpstream(row: UpstreamRecord): Promise<void> {
    await this.db.prepare(
      `INSERT INTO upstreams (id, user_id, name, url, auth_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(row.id, row.userId, row.name, row.url, row.authEnc ?? null, row.createdAt).run();
  }

  async deleteUpstream(userId: string, name: string): Promise<boolean> {
    const existing = await this.db.prepare(
      `SELECT id FROM upstreams WHERE user_id = ? AND name = ?`,
    ).bind(userId, name).first<{ id: string }>();
    if (!existing) return false;
    await this.db.prepare(`DELETE FROM upstreams WHERE user_id = ? AND name = ?`).bind(userId, name).run();
    return true;
  }

  async getSettings(userId: string): Promise<UserSettings> {
    const row = await this.db.prepare(
      `SELECT time_zone, day_end, github_daily FROM user_settings WHERE user_id = ?`,
    ).bind(userId).first<{ time_zone: string; day_end: string; github_daily: number }>();
    if (!row) return { ...DEFAULT_SETTINGS };
    return {
      timeZone: validTimeZone(row.time_zone) ? row.time_zone : DEFAULT_SETTINGS.timeZone,
      dayEnd: parseDayEnd(row.day_end) ? row.day_end : DEFAULT_SETTINGS.dayEnd,
      githubDaily: row.github_daily === 1,
    };
  }

  async saveSettings(userId: string, settings: UserSettings, now: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO user_settings (user_id, time_zone, day_end, github_daily, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         time_zone = excluded.time_zone,
         day_end = excluded.day_end,
         github_daily = excluded.github_daily,
         updated_at = excluded.updated_at`,
    ).bind(userId, settings.timeZone, settings.dayEnd, settings.githubDaily ? 1 : 0, now).run();
  }

  async listUsers(): Promise<{ id: string; login: string }[]> {
    const rows = await this.db.prepare(`SELECT id, login FROM users ORDER BY created_at`).all<{ id: string; login: string }>();
    return rows.results;
  }

  async listReceiptsBetween(userId: string, start: string, end: string, limit: number): Promise<ReceiptMeta[]> {
    const rows = await this.db.prepare(
      `SELECT id, session_id, created_at, expires_at, json_r2_key, html_r2_key, added, removed, modified, verified_claims, missing_claims, unclaimed_changes
       FROM receipts WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at ASC LIMIT ?`,
    ).bind(userId, start, end, limit).all<ReceiptSql>();
    return rows.results.map(receiptMeta);
  }

  async getDaily(userId: string, day: string): Promise<DailyDiffRow | null> {
    const row = await this.db.prepare(
      `SELECT user_id, day, finalized_at, json_r2_key, html_r2_key, card_r2_key, created_at, updated_at
       FROM daily_diffs WHERE user_id = ? AND day = ?`,
    ).bind(userId, day).first<DailySql>();
    return row ? dailyRow(row) : null;
  }

  async listDaily(userId: string): Promise<DailyDiffRow[]> {
    const rows = await this.db.prepare(
      `SELECT user_id, day, finalized_at, json_r2_key, html_r2_key, card_r2_key, created_at, updated_at
       FROM daily_diffs WHERE user_id = ? ORDER BY day DESC`,
    ).bind(userId).all<DailySql>();
    return rows.results.map(dailyRow);
  }

  async saveDaily(row: DailyDiffRow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO daily_diffs (user_id, day, finalized_at, json_r2_key, html_r2_key, card_r2_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET
         finalized_at = excluded.finalized_at,
         json_r2_key = excluded.json_r2_key,
         html_r2_key = excluded.html_r2_key,
         card_r2_key = excluded.card_r2_key,
         updated_at = excluded.updated_at`,
    ).bind(row.userId, row.day, row.finalizedAt ?? null, row.jsonKey, row.htmlKey, row.cardKey ?? null, row.createdAt, row.updatedAt).run();
  }

  async clearHistory(userId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM receipts WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
    await this.db.prepare(`DELETE FROM daily_diffs WHERE user_id = ?`).bind(userId).run();
  }
}

export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: string, contentType: string): Promise<void> {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
  }

  async putBytes(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
  }

  async get(key: string): Promise<string | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return object.text();
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
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

interface UpstreamSql {
  id: string;
  user_id: string;
  name: string;
  url: string;
  auth_enc: string | null;
  created_at: string;
}

function upstreamRecord(row: UpstreamSql): UpstreamRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    url: row.url,
    createdAt: row.created_at,
    ...(row.auth_enc ? { authEnc: row.auth_enc } : {}),
  };
}

interface DailySql {
  user_id: string;
  day: string;
  finalized_at: string | null;
  json_r2_key: string;
  html_r2_key: string;
  card_r2_key: string | null;
  created_at: string;
  updated_at: string;
}

function dailyRow(row: DailySql): DailyDiffRow {
  return {
    userId: row.user_id,
    day: row.day,
    jsonKey: row.json_r2_key,
    htmlKey: row.html_r2_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.finalized_at ? { finalizedAt: row.finalized_at } : {}),
    ...(row.card_r2_key ? { cardKey: row.card_r2_key } : {}),
  };
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
