import { actionsToClaims, validateAction, type ActionInput } from "../actions/log";
import { classifyTool, type ActionTone, type ToolEffect } from "../proxy/classify";
import { redactValue } from "../proxy/redact";
import { plainAction } from "../proxy/summary";
import { newId, addDays, addHours, clip, validTimeZone } from "../text";
import { GitHubClient } from "../github/client";
import { readAfter, takeSnapshot } from "../github/snapshot";
import type { GitHubApi, GitHubSnapshot } from "../github/types";
import { buildReceipt, plainSummary } from "../receipt/build";
import { renderHtml } from "../receipt/html";
import type { ClaimInput, Receipt, ReceiptAction } from "../receipt/types";
import { SessionBook, type LoggedAction, type NewAction, type OpenSession, type SnapshotPatch } from "../session/book";
import type { MetadataStore, ObjectStore, ReceiptMeta } from "../storage/types";

export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}

export interface SessionPort {
  getOpen(): Promise<OpenSession | null>;
  start(session: OpenSession): Promise<OpenSession>;
  log(sessionId: string, action: NewAction): Promise<LoggedAction>;
  list(sessionId: string): Promise<LoggedAction[]>;
  attach(sessionId: string, patch: SnapshotPatch): Promise<OpenSession>;
  close(sessionId: string): Promise<void>;
}

export function sessionPortFromBook(book: SessionBook): SessionPort {
  return {
    getOpen: async () => book.getOpen(),
    start: async (session) => book.start(session),
    log: async (sessionId, action) => book.log(sessionId, action),
    list: async (sessionId) => book.list(sessionId),
    attach: async (sessionId, patch) => book.attach(sessionId, patch),
    close: async (sessionId) => book.close(sessionId),
  };
}

export interface CoreDeps {
  userId: string;
  login: string;
  now: Date;
  timeZone: string;
  maxRepos: number;
  receiptRetentionDays: number;
  snapshotRetentionHours: number;
  abandonedSessionDays: number;
  sessions: SessionPort;
  meta: MetadataStore;
  objects: ObjectStore;
}

export interface AppDeps extends CoreDeps {
  github: GitHubApi;
}

export interface StartResult {
  sessionId: string;
  snapshotId: string;
  takenAt: string;
  repos: string[];
  warnings: string[];
}

export async function startSession(deps: AppDeps, input: { repos?: string[]; timeZone?: string }): Promise<StartResult> {
  const open = await deps.sessions.getOpen();
  if (open && !open.recordingOnly) throw new AppError("A session is already open. Call end_session before starting another.");
  const timeZone = input.timeZone?.trim() || deps.timeZone || "UTC";
  if (!validTimeZone(timeZone)) throw new AppError("timeZone must be an IANA name such as UTC or America/New_York.");
  const takenAt = deps.now.toISOString();
  const snapshotId = newId("snap", deps.now);
  let snapshot: GitHubSnapshot;
  try {
    snapshot = await takeSnapshot(deps.github, {
      id: snapshotId,
      takenAt,
      login: deps.login,
      maxRepos: deps.maxRepos,
      ...(input.repos ? { repos: input.repos } : {}),
    });
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "GitHub snapshot failed");
  }
  if (snapshot.repos.length === 0) {
    throw new AppError("No repositories are installed for the Life Diff GitHub App. Install it on a repository, then start again.");
  }
  const snapshotKey = `snapshots/${deps.userId}/${snapshotId}.json`;
  await deps.objects.put(snapshotKey, JSON.stringify(snapshot), "application/json");
  const repos = snapshot.repos.map((repo) => repo.fullName);
  const warnings = open?.recordingOnly
    ? [...snapshot.warnings, "GitHub was snapshotted after some tool calls were already recorded."]
    : snapshot.warnings;
  if (open?.recordingOnly) {
    if (open.snapshotKey && open.snapshotKey !== snapshotKey) await deps.objects.delete([open.snapshotKey]);
    await deps.sessions.attach(open.id, {
      snapshotId,
      snapshotKey,
      repos,
      warnings,
      recordingOnly: false,
    });
    await deps.meta.attachSession({
      id: open.id,
      snapshotId,
      snapshotKey,
      snapshotExpiresAt: addDays(takenAt, deps.abandonedSessionDays),
      repoCount: snapshot.repos.length,
    });
    return { sessionId: open.id, snapshotId, takenAt, repos, warnings };
  }
  const sessionId = newId("ses", deps.now);
  const session: OpenSession = {
    id: sessionId,
    startedAt: takenAt,
    snapshotId,
    snapshotKey,
    timeZone,
    repos,
    warnings,
  };
  await deps.sessions.start(session);
  await deps.meta.insertSession({
    id: sessionId,
    userId: deps.userId,
    startedAt: takenAt,
    status: "open",
    snapshotId,
    snapshotKey,
    snapshotExpiresAt: addDays(takenAt, deps.abandonedSessionDays),
    timeZone,
    repoCount: snapshot.repos.length,
  });
  return { sessionId, snapshotId, takenAt, repos, warnings };
}

export async function ensureRecordingSession(deps: CoreDeps): Promise<OpenSession> {
  const open = await deps.sessions.getOpen();
  if (open) return open;
  const takenAt = deps.now.toISOString();
  const snapshotId = newId("snap", deps.now);
  const sessionId = newId("ses", deps.now);
  const warnings = ["This session records tool calls. Call start_session before the work if you also want a verified GitHub diff."];
  const snapshot: GitHubSnapshot = {
    schemaVersion: "1.0.0",
    id: snapshotId,
    takenAt,
    login: deps.login,
    repos: [],
    warnings,
  };
  const snapshotKey = `snapshots/${deps.userId}/${snapshotId}.json`;
  await deps.objects.put(snapshotKey, JSON.stringify(snapshot), "application/json");
  const session: OpenSession = {
    id: sessionId,
    startedAt: takenAt,
    snapshotId,
    snapshotKey,
    timeZone: deps.timeZone || "UTC",
    repos: [],
    warnings,
    recordingOnly: true,
  };
  await deps.sessions.start(session);
  await deps.meta.insertSession({
    id: sessionId,
    userId: deps.userId,
    startedAt: takenAt,
    status: "open",
    snapshotId,
    snapshotKey,
    snapshotExpiresAt: addDays(takenAt, deps.abandonedSessionDays),
    timeZone: session.timeZone,
    repoCount: 0,
  });
  return session;
}

export interface ProxyCallInput {
  upstream: string;
  tool: string;
  args: unknown;
  ok: boolean;
  error?: string;
  durationMs: number;
  resultSummary: string;
  effect?: ToolEffect;
  tone?: ActionTone;
}

export async function recordProxyCall(deps: CoreDeps, input: ProxyCallInput): Promise<LoggedAction> {
  const open = await ensureRecordingSession(deps);
  const redacted = redactValue(input.args);
  const classified = classifyTool(input.tool);
  const effect = input.effect ?? classified.effect;
  const tone = input.tone ?? classified.tone;
  const summary = plainAction({ upstream: input.upstream, tool: input.tool, args: redacted, ok: input.ok });
  return deps.sessions.log(open.id, {
    id: newId("act", deps.now),
    loggedAt: deps.now.toISOString(),
    tool: input.tool,
    target: clip(summary, 500),
    source: "proxy",
    upstream: input.upstream,
    arguments: redacted,
    ok: input.ok,
    durationMs: input.durationMs,
    effect,
    tone,
    summary,
    ...(input.error ? { error: clip(input.error, 500) } : {}),
    ...(input.resultSummary ? { resultSummary: clip(input.resultSummary, 500) } : {}),
  });
}

export interface EndResult {
  summary: string;
  receipt: Receipt;
  html: string;
}

export async function endSession(deps: AppDeps, input: { sessionId?: string; claims?: ClaimInput[]; timeZone?: string }): Promise<EndResult> {
  const open = await deps.sessions.getOpen();
  if (!open || (input.sessionId && input.sessionId !== open.id)) throw new AppError("There is no open session to end.");
  const raw = await deps.objects.get(open.snapshotKey);
  if (!raw) throw new AppError("The snapshot for this session is missing.");
  const before = JSON.parse(raw) as GitHubSnapshot;
  const checkedAt = deps.now.toISOString();
  let after;
  try {
    after = await readAfter(deps.github, before, checkedAt);
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "GitHub diff failed");
  }
  const logged = await deps.sessions.list(open.id);
  const claims = combineClaims(logged, input.claims);
  const actions = toReceiptActions(logged);
  const timeZone = input.timeZone && validTimeZone(input.timeZone) ? input.timeZone : open.timeZone;
  const receiptId = newId("rcpt", deps.now);
  const receipt = buildReceipt({
    receiptId,
    before,
    after,
    checkedAt,
    timeZone,
    claims,
    actions,
  });
  const html = renderHtml(receipt);
  const jsonKey = `receipts/${deps.userId}/${receiptId}.json`;
  const htmlKey = `receipts/${deps.userId}/${receiptId}.html`;
  await deps.objects.put(jsonKey, JSON.stringify(receipt), "application/json");
  await deps.objects.put(htmlKey, html, "text/html; charset=utf-8");
  await deps.meta.insertReceipt({
    id: receiptId,
    userId: deps.userId,
    sessionId: open.id,
    createdAt: checkedAt,
    expiresAt: addDays(checkedAt, deps.receiptRetentionDays),
    jsonKey,
    htmlKey,
    added: receipt.counts.added,
    removed: receipt.counts.removed,
    modified: receipt.counts.modified,
    verifiedClaims: receipt.counts.verifiedClaims,
    missingClaims: receipt.counts.missingClaims,
    unclaimedChanges: receipt.counts.unclaimedChanges,
  });
  await deps.meta.closeSession({
    id: open.id,
    endedAt: checkedAt,
    receiptId,
    snapshotExpiresAt: addHours(checkedAt, deps.snapshotRetentionHours),
  });
  await deps.sessions.close(open.id);
  return { summary: plainSummary(receipt), receipt, html };
}

export async function logAction(deps: CoreDeps, input: ActionInput & { sessionId?: string }): Promise<LoggedAction> {
  const open = await deps.sessions.getOpen();
  if (!open || (input.sessionId && input.sessionId !== open.id)) throw new AppError("There is no open session to log against. Call start_session first.");
  let normalized;
  try {
    normalized = validateAction(input);
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "Invalid action");
  }
  return deps.sessions.log(open.id, {
    id: newId("act", deps.now),
    loggedAt: deps.now.toISOString(),
    tool: input.tool.trim(),
    target: input.target.trim(),
    ...normalized,
    ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
  });
}

export async function getReceipt(deps: CoreDeps, receiptId: string): Promise<{ receipt: Receipt; html: string; meta: ReceiptMeta }> {
  const meta = await deps.meta.getReceipt(deps.userId, receiptId);
  if (!meta) throw new AppError("No receipt with that id.");
  const json = await deps.objects.get(meta.jsonKey);
  const html = await deps.objects.get(meta.htmlKey);
  if (!json || !html) throw new AppError("That receipt is no longer stored.");
  return { receipt: JSON.parse(json) as Receipt, html, meta };
}

export async function listReceipts(deps: CoreDeps, limit: number): Promise<ReceiptMeta[]> {
  const capped = Math.min(Math.max(limit, 1), 50);
  return deps.meta.listReceipts(deps.userId, capped);
}

export function combineClaims(actions: LoggedAction[], extra: ClaimInput[] | undefined): ClaimInput[] | null {
  const logged = actionsToClaims(actions);
  if (extra === undefined && logged.length === 0) return null;
  return [...logged, ...(extra ?? [])];
}

export function toReceiptActions(actions: LoggedAction[]): ReceiptAction[] {
  return actions.flatMap((action) => {
    if (action.source !== "proxy" || !action.upstream || !action.summary || !action.effect || !action.tone) return [];
    const recorded: ReceiptAction = {
      id: action.id,
      time: action.loggedAt,
      upstream: action.upstream,
      tool: action.tool,
      arguments: action.arguments ?? {},
      ok: action.ok !== false,
      summary: action.summary,
      durationMs: action.durationMs ?? 0,
      effect: action.effect,
      tone: action.tone,
      source: "proxy",
      ...(action.error ? { error: action.error } : {}),
      ...(action.resultSummary ? { resultSummary: action.resultSummary } : {}),
    };
    return [recorded];
  });
}

export function githubForToken(token: string, fetchImpl?: typeof fetch): GitHubApi {
  return new GitHubClient({ token, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
