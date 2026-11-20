import { receiptCardKey } from "../receipt/card";
import { roundupJsonKey } from "../receipt/roundup";
import type { AbandonedSession, MetadataStore, ObjectStore } from "./types";

export interface SessionSweeper {
  abandon(userId: string, sessionId: string): Promise<void>;
  wipe(userId: string): Promise<void>;
}

export interface RetentionReport {
  receipts: number;
  snapshots: number;
  abandoned: number;
}

export async function runRetention(input: {
  meta: MetadataStore;
  objects: ObjectStore;
  sessions: SessionSweeper;
  nowIso: string;
  limit: number;
}): Promise<RetentionReport> {
  const receipts = await input.meta.expiredReceipts(input.nowIso, input.limit);
  await input.objects.delete(receipts.flatMap((row) => [row.jsonKey, row.htmlKey, receiptCardKey(row.jsonKey)]));
  await input.meta.deleteReceipts(receipts.map((row) => row.id));

  const snapshots = await input.meta.expiredSnapshots(input.nowIso, input.limit);
  await input.objects.delete(snapshots.map((row) => row.key));
  await input.meta.clearSnapshots(snapshots.map((row) => row.sessionId));

  const abandoned = await input.meta.abandonedSessions(input.nowIso, input.limit);
  for (const row of abandoned) {
    await input.sessions.abandon(row.userId, row.sessionId);
  }
  await input.objects.delete(abandoned.flatMap((row) => (row.snapshotKey ? [row.snapshotKey] : [])));
  await input.meta.deleteSessions(abandoned.map((row) => row.sessionId));
  return { receipts: receipts.length, snapshots: snapshots.length, abandoned: abandoned.length };
}

export async function deleteUserData(input: {
  meta: MetadataStore;
  objects: ObjectStore;
  sessions: SessionSweeper;
  userId: string;
}): Promise<{ objects: number }> {
  const roundupKey = roundupJsonKey(input.userId);
  const roundupRaw = await input.objects.get(roundupKey);
  const extra = [roundupKey];
  if (roundupRaw) {
    try {
      const cardKey = (JSON.parse(roundupRaw) as { cardKey?: string }).cardKey;
      if (cardKey?.startsWith("roundups/") && cardKey.endsWith(".png")) extra.push(cardKey);
    } catch {
      // The roundup file is removed either way.
    }
  }
  const keys = [...await input.meta.userObjectKeys(input.userId), ...extra];
  await input.objects.delete(keys);
  await input.sessions.wipe(input.userId);
  await input.meta.deleteUserRows(input.userId);
  return { objects: keys.length };
}

export type { AbandonedSession };
