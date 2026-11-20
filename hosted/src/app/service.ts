import { actionsToClaims, validateAction, type ActionInput } from "../actions/log";
import { newId, addDays, addHours, randomToken, validTimeZone } from "../text";
import { receiptCardKey, renderCardPng } from "../receipt/card";
import { storyFromReceipt } from "../receipt/story";
import { GitHubClient } from "../github/client";
import { readAfter, takeSnapshot } from "../github/snapshot";
import type { GitHubApi, GitHubSnapshot } from "../github/types";
import { buildActionReceipt, buildReceipt, plainSummary } from "../receipt/build";
import { renderHtml } from "../receipt/html";
import type { ClaimInput, ClaimResult, Receipt, RecordedAction } from "../receipt/types";
import { SessionBook, type LoggedAction, type NewAction, type OpenSession } from "../session/book";
import type { Classification } from "../proxy/classify";
import { boundJson } from "../proxy/redact";
import { recordedFrom } from "../receipt/actions";
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
  close(sessionId: string): Promise<void>;
}

export function sessionPortFromBook(book: SessionBook): SessionPort {
  return {
    getOpen: async () => book.getOpen(),
    start: async (session) => book.start(session),
    log: async (sessionId, action) => book.log(sessionId, action),
    list: async (sessionId) => book.list(sessionId),
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

const STALE_SESSION_MS = 30 * 60 * 1000;

export async function startSession(deps: AppDeps, input: { repos?: string[]; timeZone?: string }): Promise<StartResult> {
  const open = await deps.sessions.getOpen();
  if (open) {
    const age = deps.now.getTime() - Date.parse(open.startedAt);
    if (Number.isFinite(age) && age < STALE_SESSION_MS) {
      return {
        sessionId: open.id,
        snapshotId: open.snapshotId,
        takenAt: open.startedAt,
        repos: open.repos,
        warnings: open.warnings,
      };
    }
    await endSession(deps, { sessionId: open.id });
  }
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
  const sessionId = newId("ses", deps.now);
  const session: OpenSession = {
    id: sessionId,
    startedAt: takenAt,
    snapshotId,
    snapshotKey,
    timeZone,
    repos: snapshot.repos.map((repo) => repo.fullName),
    warnings: snapshot.warnings,
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
  return { sessionId, snapshotId, takenAt, repos: session.repos, warnings: snapshot.warnings };
}

export interface EndResult {
  summary: string;
  receipt: Receipt;
  html: string;
}

export async function endSession(deps: AppDeps, input: { sessionId?: string; claims?: ClaimInput[]; timeZone?: string }): Promise<EndResult> {
  const open = await deps.sessions.getOpen();
  if (!open || (input.sessionId && input.sessionId !== open.id)) throw new AppError("There is no open session to end.");
  const checkedAt = deps.now.toISOString();
  const logged = await deps.sessions.list(open.id);
  const claims = combineClaims(logged, input.claims);
  const timeZone = input.timeZone && validTimeZone(input.timeZone) ? input.timeZone : open.timeZone;
  const receiptId = newId("rcpt", deps.now);
  const actions = recordedActions(logged);
  let receipt: Receipt;
  if (!open.snapshotKey) {
    receipt = buildActionReceipt({
      receiptId,
      startedAt: open.startedAt,
      checkedAt,
      timeZone,
      actions,
    });
    if (claims && claims.length > 0) {
      receipt.claimsChecked = true;
      receipt.claims = claims.map((claim, index): ClaimResult => ({
        id: claim.id ?? `claim_${index + 1}`,
        target: claim.target,
        status: "missing",
        reason: "This session did not snapshot GitHub, so Life Diff could not verify this claim.",
        ...(claim.service ? { service: claim.service } : {}),
        ...(claim.action ? { action: claim.action } : {}),
        ...(claim.detail ? { detail: claim.detail } : {}),
        ...(claim.repo ? { repo: claim.repo } : {}),
      }));
      receipt.counts = { ...receipt.counts, missingClaims: receipt.claims.length };
      receipt.notes.push("Claims were not compared with GitHub because this session has no snapshot.");
    }
  } else {
    const raw = await deps.objects.get(open.snapshotKey);
    if (!raw) throw new AppError("The snapshot for this session is missing.");
    const before = JSON.parse(raw) as GitHubSnapshot;
    let after;
    try {
      after = await readAfter(deps.github, before, checkedAt);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : "GitHub diff failed");
    }
    receipt = buildReceipt({
      receiptId,
      before,
      after,
      checkedAt,
      timeZone,
      claims,
    });
    if (actions.length > 0) {
      receipt.actions = actions;
      receipt.notes.push("Tool calls routed through Life Diff are marked reported by the proxy. They are not proof the service changed.");
    }
  }
  const jsonKey = `receipts/${deps.userId}/${receiptId}.json`;
  const htmlKey = `receipts/${deps.userId}/${receiptId}.html`;
  try {
    const png = await renderCardPng(storyFromReceipt(receipt), "Life Diff");
    receipt.cardToken = randomToken();
    await deps.objects.putBytes(receiptCardKey(jsonKey), png, "image/png");
  } catch {
    delete receipt.cardToken;
  }
  const html = renderHtml(receipt);
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

export async function ensureSession(deps: CoreDeps): Promise<OpenSession> {
  const open = await deps.sessions.getOpen();
  if (open) return open;
  try {
    return await startActionSession(deps);
  } catch (error) {
    const again = await deps.sessions.getOpen();
    if (again) return again;
    throw error;
  }
}

async function startActionSession(deps: CoreDeps): Promise<OpenSession> {
  const takenAt = deps.now.toISOString();
  const sessionId = newId("ses", deps.now);
  const session: OpenSession = {
    id: sessionId,
    startedAt: takenAt,
    snapshotId: "none",
    snapshotKey: "",
    timeZone: deps.timeZone || "UTC",
    repos: [],
    warnings: [],
  };
  await deps.sessions.start(session);
  await deps.meta.insertSession({
    id: sessionId,
    userId: deps.userId,
    startedAt: takenAt,
    status: "open",
    snapshotId: "none",
    snapshotKey: "",
    snapshotExpiresAt: addDays(takenAt, deps.abandonedSessionDays),
    timeZone: session.timeZone,
    repoCount: 0,
  });
  return session;
}

export async function recordProxyCall(deps: CoreDeps, input: {
  upstream: string;
  tool: string;
  args: unknown;
  ok: boolean;
  status: string;
  summary: string;
  classification: Classification;
  durationMs: number;
  result?: string;
  error?: string;
}): Promise<LoggedAction> {
  const open = await ensureSession(deps);
  return deps.sessions.log(open.id, {
    id: newId("act", deps.now),
    loggedAt: deps.now.toISOString(),
    tool: input.tool.slice(0, 200),
    target: input.summary.slice(0, 500),
    source: "proxy",
    upstream: input.upstream,
    arguments: boundJson(input.args),
    ok: input.ok,
    status: input.status,
    summary: input.summary,
    effect: input.classification.effect,
    tone: input.classification.tone,
    durationMs: input.durationMs,
    ...(input.classification.verb ? { verb: input.classification.verb } : {}),
    ...(input.result ? { result: input.result.slice(0, 500) } : {}),
    ...(input.error ? { error: input.error.slice(0, 500) } : {}),
  });
}

function recordedActions(actions: LoggedAction[]): RecordedAction[] {
  return actions.flatMap((action) => {
    const recorded = recordedFrom(action);
    return recorded ? [recorded] : [];
  });
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

export function githubForToken(token: string, fetchImpl?: typeof fetch): GitHubApi {
  return new GitHubClient({ token, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
