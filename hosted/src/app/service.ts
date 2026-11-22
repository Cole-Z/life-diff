import { historyObjectKeys } from "../storage/retention";
import { actionsToClaims, validateAction, type ActionInput } from "../actions/log";
import { serviceFromTool } from "../receipt/names";
import { isGitHubClaimService } from "../receipt/claims";
import { newId, addDays, addHours, randomToken, validTimeZone } from "../text";
import { DEFAULT_TIME_ZONE } from "../time";
import { receiptCardKey, renderCardPng } from "../receipt/card";
import { agentTitle, condenseLines, storyFromReceipt, undoPlansFor } from "../receipt/story";
import { GitHubClient } from "../github/client";
import { readAfter, takeSnapshot } from "../github/snapshot";
import type { GitHubApi, GitHubSnapshot } from "../github/types";
import { buildActionReceipt, buildReceipt, plainSummary } from "../receipt/build";
import { renderHtml } from "../receipt/html";
import type { ClaimInput, ClaimResult, Receipt, RecordedAction } from "../receipt/types";
import { SessionBook, type CloseClaim, type LoggedAction, type NewAction, type OpenSession } from "../session/book";
import type { Classification } from "../proxy/classify";
import { boundJson, redactSnippet, redactStrings, redactText } from "../proxy/redact";
import { attachReadClaims, corroborateActions } from "../receipt/corroborate";
import { phraseAction } from "../receipt/phrase";
import type { MetadataStore, ObjectStore, ReceiptMeta, SessionRow } from "../storage/types";

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
  touch(sessionId: string, at: string): Promise<void>;
  setAgentName(sessionId: string, name: string): Promise<void>;
  claimClose(sessionId?: string): Promise<CloseClaim>;
  abortClose(sessionId: string): Promise<void>;
}

export function sessionPortFromBook(book: SessionBook): SessionPort {
  return {
    getOpen: async () => book.getOpen(),
    start: async (session) => book.start(session),
    log: async (sessionId, action) => book.log(sessionId, action),
    list: async (sessionId) => book.list(sessionId),
    close: async (sessionId) => book.close(sessionId),
    touch: async (sessionId, at) => book.touch(sessionId, at),
    setAgentName: async (sessionId, name) => book.setAgentName(sessionId, name),
    claimClose: async (sessionId) => book.claimClose(sessionId),
    abortClose: async (sessionId) => book.abortClose(sessionId),
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

export const DEFAULT_IDLE_MINUTES = 20;
const RECENT_CLOSE_MS = 24 * 60 * 60 * 1000;
const CLOSE_WAIT_MS = 15_000;
const CLOSE_POLL_MS = 20;

export async function startSession(deps: AppDeps, input: { repos?: string[]; timeZone?: string; agentName?: string }): Promise<StartResult> {
  const requested = namedRepos(input.repos);
  const timeZone = await resolveZone(deps, input.timeZone);
  const open = await deps.sessions.getOpen();
  if (open && sameRepos(open.repos, requested) && !(await sessionIsIdle(deps, open))) {
    await deps.sessions.touch(open.id, deps.now.toISOString());
    if (input.agentName?.trim()) await deps.sessions.setAgentName(open.id, input.agentName);
    return {
      sessionId: open.id,
      snapshotId: open.snapshotId,
      takenAt: open.startedAt,
      repos: open.repos,
      warnings: open.warnings,
    };
  }
  if (open) await releaseOpen(deps, open, deps.github);
  if (requested.length === 0) {
    const session = await startActionSession(deps, timeZone, input.agentName);
    return { sessionId: session.id, snapshotId: session.snapshotId, takenAt: session.startedAt, repos: [], warnings: [] };
  }
  const takenAt = deps.now.toISOString();
  const snapshotId = newId("snap", deps.now);
  let snapshot: GitHubSnapshot;
  try {
    snapshot = await takeSnapshot(deps.github, {
      id: snapshotId,
      takenAt,
      login: deps.login,
      maxRepos: deps.maxRepos,
      repos: requested,
    });
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "GitHub snapshot failed");
  }
  if (snapshot.repos.length === 0) {
    const why = snapshot.warnings[0] ? ` ${snapshot.warnings[0]}` : "";
    throw new AppError(`None of the named repositories are installed for the Life Diff GitHub App.${why}`);
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
    githubOptIn: true,
    ...(input.agentName?.trim() ? { agentName: input.agentName.trim().slice(0, 80) } : {}),
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
    githubOptIn: true,
  });
  return { sessionId, snapshotId, takenAt, repos: session.repos, warnings: snapshot.warnings };
}

export interface EndResult {
  summary: string;
  receipt: Receipt;
  html: string;
}

export async function endSession(deps: AppDeps, input: { sessionId?: string; claims?: ClaimInput[]; timeZone?: string; allowGitHubFailure?: boolean; agentName?: string }): Promise<EndResult> {
  const claim = await deps.sessions.claimClose(input.sessionId);
  switch (claim.status) {
    case "mismatch":
    case "busy":
    case "idle": {
      const existing = await replayClosed(deps, input.sessionId, claim.status === "busy");
      if (existing) return existing;
      throw new AppError("There is no open session to end.");
    }
    case "claimed":
      break;
    default: {
      const never: never = claim;
      throw new AppError(`Unhandled close (${JSON.stringify(never)})`);
    }
  }
  const prior = await replayClosed(deps, claim.session.id, false);
  if (prior) {
    await deps.sessions.close(claim.session.id);
    return prior;
  }
  try {
    return await commitClose(deps, claim, input);
  } catch (error) {
    try { await deps.sessions.abortClose(claim.session.id); } catch { /* the original error is the one to surface */ }
    throw error;
  }
}

async function commitClose(deps: AppDeps, claim: Extract<CloseClaim, { status: "claimed" }>, input: { sessionId?: string; claims?: ClaimInput[]; timeZone?: string; allowGitHubFailure?: boolean; agentName?: string }): Promise<EndResult> {
  const open = claim.session;
  const checkedAt = deps.now.toISOString();
  const logged = claim.actions;
  const folded = corroborateActions(logged);
  const foldedIds = new Set(folded.foldedClaimIds);
  const prepared = prepareClaims(combineClaims(logged, input.claims)).filter((item) => !item.id || !foldedIds.has(item.id));
  const hasSnapshot = Boolean(open.snapshotKey);
  const githubClaims = hasSnapshot ? prepared.filter((claim) => isGitHubClaimService(claim.service)) : [];
  const timeZone = input.timeZone && validTimeZone(input.timeZone) ? input.timeZone : open.timeZone;
  const receiptId = newId("rcpt", deps.now);
  const actions = folded.recorded;
  let receipt: Receipt;
  if (!hasSnapshot) {
    receipt = buildActionReceipt({
      receiptId,
      startedAt: open.startedAt,
      checkedAt,
      timeZone,
      actions,
    });
  } else {
    const github = await readGitHubReceipt(deps, open, {
      receiptId,
      checkedAt,
      timeZone,
      claims: githubClaims.length > 0 ? githubClaims : null,
      actions,
      allowFailure: input.allowGitHubFailure === true,
    });
    receipt = github;
  }
  addUnverifiedClaims(receipt, hasSnapshot ? prepared.filter((claim) => !isGitHubClaimService(claim.service)) : prepared, hasSnapshot);
  attachReadClaims(receipt, folded.readClaims);
  const clients = new Set(actions.map((action) => action.client).filter(Boolean));
  const agentName = clients.size === 1 ? [...clients][0] : (input.agentName || open.agentName || "").trim().slice(0, 80);
  if (clients.size < 2 && agentName) receipt.agentName = agentName;
  receipt = redactStrings(receipt);
  const jsonKey = `receipts/${deps.userId}/${receiptId}.json`;
  const htmlKey = `receipts/${deps.userId}/${receiptId}.html`;
  try {
    const lines = condenseLines(storyFromReceipt(receipt), { detail: false });
    const png = await renderCardPng(lines, agentTitle(lines, receipt.timeZone, receipt.session.startedAt, receipt.session.checkedAt, receipt.agentName), "SESSION DIFF");
    receipt.cardToken = randomToken();
    await deps.objects.putBytes(receiptCardKey(jsonKey), png, "image/png");
  } catch {
    delete receipt.cardToken;
  }
  const html = redactText(renderHtml(receipt));
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
  const won = await deps.meta.closeSession({
    id: open.id,
    endedAt: checkedAt,
    receiptId,
    snapshotExpiresAt: addHours(checkedAt, deps.snapshotRetentionHours),
  });
  if (!won) {
    await deps.meta.deleteReceipt(receiptId);
    await deps.objects.delete([jsonKey, htmlKey, receiptCardKey(jsonKey)]);
    try { await deps.sessions.close(open.id); } catch { /* already closed in the session log */ }
    const existing = await replayClosed(deps, open.id, true);
    if (existing) return existing;
    throw new AppError("There is no open session to end.");
  }
  await deps.sessions.close(open.id);
  return { summary: plainSummary(receipt), receipt, html };
}

async function replayClosed(deps: CoreDeps, sessionId: string | undefined, wait: boolean): Promise<EndResult | null> {
  const deadline = Date.now() + (wait ? CLOSE_WAIT_MS : 0);
  for (;;) {
    const row = await closedRow(deps, sessionId);
    if (row?.receiptId && recentlyClosed(deps, row)) {
      const loaded = await loadStoredReceipt(deps, row.receiptId);
      if (loaded) return loaded;
    }
    if (!wait || Date.now() >= deadline) return null;
    await delay(CLOSE_POLL_MS);
  }
}

async function closedRow(deps: CoreDeps, sessionId: string | undefined): Promise<SessionRow | null> {
  if (sessionId) {
    const row = await deps.meta.getSession(deps.userId, sessionId);
    if (!row || row.status !== "closed") return null;
    return row;
  }
  return deps.meta.latestClosedSession(deps.userId);
}

function recentlyClosed(deps: CoreDeps, row: SessionRow): boolean {
  if (!row.endedAt) return false;
  const ended = Date.parse(row.endedAt);
  if (!Number.isFinite(ended)) return false;
  const age = deps.now.getTime() - ended;
  return age >= 0 && age <= RECENT_CLOSE_MS;
}

async function loadStoredReceipt(deps: CoreDeps, receiptId: string): Promise<EndResult | null> {
  const meta = await deps.meta.getReceipt(deps.userId, receiptId);
  if (!meta) return null;
  const json = await deps.objects.get(meta.jsonKey);
  const html = await deps.objects.get(meta.htmlKey);
  if (!json || !html) return null;
  try {
    const receipt = redactStrings(JSON.parse(json) as Receipt);
    return { summary: plainSummary(receipt), receipt, html: redactText(html) };
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureSession(deps: CoreDeps): Promise<OpenSession> {
  const open = await deps.sessions.getOpen();
  if (open && !(await sessionIsIdle(deps, open))) return open;
  if (open) await releaseOpen(deps, open);
  try {
    return await startActionSession(deps);
  } catch (error) {
    const again = await deps.sessions.getOpen();
    if (again && !(await sessionIsIdle(deps, again))) return again;
    if (again) {
      try { await deps.sessions.close(again.id); } catch { /* already closed */ }
    }
    return startActionSession(deps);
  }
}

export async function closeIdleSession(deps: CoreDeps, github?: GitHubApi): Promise<void> {
  const open = await deps.sessions.getOpen();
  if (!open || !(await sessionIsIdle(deps, open))) return;
  await releaseOpen(deps, open, github);
}

async function sessionIsIdle(deps: CoreDeps, open: OpenSession): Promise<boolean> {
  const settings = await deps.meta.getSettings(deps.userId);
  const minutes = clampIdle(settings.idleMinutes);
  const activity = Date.parse(open.activityAt || open.startedAt);
  if (!Number.isFinite(activity)) return false;
  return deps.now.getTime() - activity >= minutes * 60 * 1000;
}

function clampIdle(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_IDLE_MINUTES;
  return Math.min(180, Math.max(5, Math.round(value)));
}

async function releaseOpen(deps: CoreDeps, open: OpenSession, github?: GitHubApi): Promise<void> {
  try {
    await endSession({ ...deps, github: github ?? deniedGithub() }, { sessionId: open.id, allowGitHubFailure: true });
  } catch {
    try { await deps.sessions.close(open.id); } catch { /* a stale session must not block the next start */ }
  }
  const still = await deps.sessions.getOpen();
  if (still?.id === open.id) {
    try { await deps.sessions.close(still.id); } catch { /* already closed */ }
  }
}

function deniedGithub(): GitHubApi {
  const fail = async (): Promise<never> => {
    throw new Error("GitHub was not read while closing an idle session.");
  };
  return {
    listInstallations: fail,
    listInstallationRepos: fail,
    listBranches: fail,
    listPulls: fail,
    listIssues: fail,
    listCommits: fail,
    compare: fail,
    listIssueComments: fail,
    listReviewComments: fail,
  };
}

async function startActionSession(deps: CoreDeps, timeZone?: string, agentName?: string): Promise<OpenSession> {
  const zone = timeZone && validTimeZone(timeZone) ? timeZone : await resolveZone(deps);
  const takenAt = deps.now.toISOString();
  const sessionId = newId("ses", deps.now);
  const session: OpenSession = {
    id: sessionId,
    startedAt: takenAt,
    snapshotId: "none",
    snapshotKey: "",
    timeZone: zone,
    repos: [],
    warnings: [],
    ...(agentName?.trim() ? { agentName: agentName.trim().slice(0, 80) } : {}),
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
    timeZone: zone,
    repoCount: 0,
  });
  return session;
}

async function readGitHubReceipt(deps: AppDeps, open: OpenSession, input: {
  receiptId: string;
  checkedAt: string;
  timeZone: string;
  claims: ClaimInput[] | null;
  actions: RecordedAction[];
  allowFailure: boolean;
}): Promise<Receipt> {
  const fallback = (note: string): Receipt => {
    const receipt = buildActionReceipt({
      receiptId: input.receiptId,
      startedAt: open.startedAt,
      checkedAt: input.checkedAt,
      timeZone: input.timeZone,
      actions: input.actions,
    });
    receipt.notes.push(note);
    return receipt;
  };
  const raw = await deps.objects.get(open.snapshotKey);
  if (!raw) {
    if (input.allowFailure) return fallback("The GitHub snapshot was missing, so this receipt has no repository diff.");
    throw new AppError("The snapshot for this session is missing.");
  }
  try {
    const before = JSON.parse(raw) as GitHubSnapshot;
    const after = await readAfter(deps.github, before, input.checkedAt);
    const receipt = buildReceipt({
      receiptId: input.receiptId,
      before,
      after,
      checkedAt: input.checkedAt,
      timeZone: input.timeZone,
      claims: input.claims,
      githubOptIn: open.githubOptIn === true,
    });
    if (input.actions.length > 0) {
      receipt.actions = input.actions;
      receipt.notes.push("Tool calls Life Diff forwarded say Sent to that service, not verified. They are not proof the service changed.");
    }
    return receipt;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (!input.allowFailure) throw new AppError(error instanceof Error ? error.message : "GitHub diff failed");
    return fallback("GitHub could not be re-read, so this receipt has no repository diff.");
  }
}

async function resolveZone(deps: CoreDeps, requested?: string): Promise<string> {
  const settings = await deps.meta.getSettings(deps.userId);
  const explicit = requested?.trim();
  if (explicit) {
    if (!validTimeZone(explicit)) throw new AppError("timeZone must be an IANA name such as America/Chicago.");
    if (explicit !== settings.timeZone) {
      await deps.meta.saveSettings(deps.userId, { ...settings, timeZone: explicit }, deps.now.toISOString());
    }
    return explicit;
  }
  return validTimeZone(settings.timeZone) ? settings.timeZone : DEFAULT_TIME_ZONE;
}

function namedRepos(repos: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const repo of repos ?? []) {
    const trimmed = repo.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function sameRepos(left: string[], right: string[]): boolean {
  const norm = (repos: string[]) => repos.map((repo) => repo.toLowerCase()).sort().join("\n");
  return norm(left) === norm(right);
}

export async function sealOpenSession(deps: AppDeps): Promise<void> {
  const open = await deps.sessions.getOpen();
  if (!open) return;
  await endSession(deps, { sessionId: open.id, allowGitHubFailure: true });
}

export async function clearHistory(deps: { userId: string; meta: CoreDeps["meta"]; objects: CoreDeps["objects"] }, wipe: () => Promise<void>): Promise<void> {
  const keys = await historyObjectKeys(deps.meta, deps.objects, deps.userId);
  await deps.objects.delete(keys);
  await wipe();
  await deps.meta.clearHistory(deps.userId);
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
  client?: string;
}): Promise<LoggedAction> {
  const open = await ensureSession(deps);
  return deps.sessions.log(open.id, {
    id: newId("act", deps.now),
    loggedAt: deps.now.toISOString(),
    tool: input.tool.slice(0, 200),
    target: redactText(input.summary).slice(0, 500),
    source: "proxy",
    upstream: input.upstream,
    arguments: boundJson(input.args),
    ok: input.ok,
    status: input.status,
    summary: redactText(input.summary),
    effect: input.classification.effect,
    tone: input.classification.tone,
    durationMs: input.durationMs,
    ...(input.classification.verb ? { verb: input.classification.verb } : {}),
    ...(input.result ? { result: redactSnippet(input.result) } : {}),
    ...(input.error ? { error: redactSnippet(input.error) } : {}),
    ...(input.client ? { client: input.client.slice(0, 80) } : {}),
  });
}

export async function logAction(deps: CoreDeps, input: ActionInput & { sessionId?: string; client?: string }): Promise<LoggedAction> {
  const open = await deps.sessions.getOpen();
  if (!open || (input.sessionId && input.sessionId !== open.id)) throw new AppError("There is no open session to log against. Call start_session first.");
  let normalized;
  try {
    normalized = validateAction(input);
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "Invalid action");
  }
  const tool = input.tool.trim();
  const target = redactText(input.target.trim());
  const read = normalized.action === "read";
  const derived = serviceFromTool(tool);
  const tone = read ? "read" as const : claimTone(normalized.action);
  const verb = read ? "read" : claimVerb(normalized.action, normalized.before, normalized.after);
  return deps.sessions.log(open.id, {
    id: newId("act", deps.now),
    loggedAt: deps.now.toISOString(),
    tool,
    target,
    source: "claim",
    upstream: derived.display,
    effect: read ? "read" : "write",
    tone,
    verb,
    ok: true,
    status: "ok",
    arguments: {
      subject: target,
      ...(normalized.before ? { before: redactText(normalized.before) } : {}),
      ...(normalized.after ? { after: redactText(normalized.after) } : {}),
      ...(normalized.url ? { url: normalized.url } : {}),
    },
    summary: read
      ? phraseAction({
        upstream: derived.display,
        tool: "read",
        classification: { effect: "read", tone: "read", verb: "read" },
        subject: target,
        ok: true,
      })
      : target,
    ...normalized,
    ...(input.detail?.trim() ? { detail: redactText(input.detail.trim()) } : {}),
    ...(input.client?.trim() ? { client: input.client.trim().slice(0, 80) } : {}),
  });
}

function claimTone(action: string | undefined): "created" | "changed" | "removed" | "moved" | "shared" {
  switch (action) {
    case "added":
      return "created";
    case "removed":
      return "removed";
    case "moved":
      return "moved";
    case "shared":
      return "shared";
    default:
      return "changed";
  }
}

function claimVerb(action: string | undefined, before?: string, after?: string): string {
  if (action === "added") return "create";
  if (action === "removed") return "delete";
  if (action === "moved") return "move";
  if (action === "shared") return "share";
  if (before && after && (/\b(am|pm)\b/i.test(`${before} ${after}`) || /\d:\d\d/.test(`${before} ${after}`))) return "move";
  return "update";
}

function prepareClaims(claims: ClaimInput[] | null): ClaimInput[] {
  return (claims ?? []).map((claim, index) => ({
    ...claim,
    id: claim.id?.trim() || `claim-${index + 1}`,
    target: claim.target.trim(),
  }));
}

function addUnverifiedClaims(receipt: Receipt, claims: ClaimInput[], hasSnapshot: boolean): void {
  if (claims.length === 0) return;
  const have = new Set(receipt.claims.map((claim) => claim.id));
  const added: ClaimResult[] = [];
  for (const claim of claims) {
    const id = claim.id?.trim() || `claim-${receipt.claims.length + added.length + 1}`;
    if (have.has(id)) continue;
    const github = isGitHubClaimService(claim.service);
    added.push({
      id,
      target: redactText(claim.target),
      status: "missing",
      reason: github && !hasSnapshot
        ? "This session did not snapshot GitHub, so Life Diff could not verify this claim."
        : github
          ? "No matching change showed up in GitHub."
          : "Life Diff cannot check this service. This is what the agent reported.",
      ...(claim.service ? { service: claim.service } : {}),
      ...(claim.action ? { action: claim.action } : {}),
      ...(claim.detail ? { detail: redactText(claim.detail) } : {}),
      ...(claim.repo ? { repo: claim.repo } : {}),
      ...(claim.before ? { before: redactText(claim.before) } : {}),
      ...(claim.after ? { after: redactText(claim.after) } : {}),
      ...(claim.url ? { url: claim.url } : {}),
    });
  }
  if (added.length === 0) return;
  receipt.claimsChecked = true;
  receipt.claims = [...receipt.claims, ...added];
  receipt.counts = { ...receipt.counts, missingClaims: receipt.counts.missingClaims + added.length };
}

export async function requestUndo(deps: CoreDeps, input: { receiptId: string; changeId?: string; origin: string }): Promise<{
  receiptId: string;
  recorded: "undo requested";
  undos: (ReturnType<typeof undoPlansFor>[number] & { requested: true })[];
}> {
  const loaded = await getReceipt(deps, input.receiptId);
  const lines = condenseLines(storyFromReceipt(loaded.receipt), { detail: false });
  if (input.changeId) {
    const line = lines.find((item) => item.id === input.changeId);
    if (!line) throw new AppError("That change is not on this receipt.");
    if (!line.undo) throw new AppError("Undo is not available for that row. Life Diff only offers undo for a change it logged, forwarded, or verified.");
  }
  const plans = undoPlansFor(loaded.receipt, input.origin);
  const chosen = input.changeId ? plans.filter((plan) => plan.changeId === input.changeId) : plans;
  if (chosen.length === 0) throw new AppError("Nothing on this receipt has an undo prompt.");
  const open = await ensureSession(deps);
  const summary = chosen.length === 1
    ? `Undo requested. Life Diff did not run it. ${chosen[0]?.prompt ?? ""}`.trim()
    : `Undo requested for ${chosen.length} changes. Life Diff did not run it.`;
  await deps.sessions.log(open.id, {
    id: newId("act", deps.now),
    loggedAt: deps.now.toISOString(),
    tool: "undo_request",
    target: summary.slice(0, 500),
    source: "proxy",
    upstream: "Life Diff",
    effect: "read",
    tone: "read",
    verb: "undo",
    ok: true,
    status: "undo_requested",
    summary: summary.slice(0, 500),
    arguments: { receiptId: input.receiptId, changeIds: chosen.map((plan) => plan.changeId) },
  });
  const seeds = new Set(loaded.receipt.undoRequestedSeeds ?? []);
  for (const plan of chosen) {
    const line = lines.find((item) => item.id === plan.changeId);
    if (line) seeds.add(line.seed);
  }
  loaded.receipt.undoRequestedSeeds = [...seeds];
  await rewriteReceipt(deps, loaded.meta.jsonKey, loaded.meta.htmlKey, loaded.receipt);
  const undos = chosen.map((plan) => ({ ...plan, requested: true as const }));
  return { receiptId: input.receiptId, recorded: "undo requested", undos };
}

async function rewriteReceipt(deps: CoreDeps, jsonKey: string, htmlKey: string, receipt: Receipt): Promise<void> {
  const lines = condenseLines(storyFromReceipt(receipt), { detail: false });
  const html = redactText(renderHtml(receipt));
  await deps.objects.put(jsonKey, JSON.stringify(receipt), "application/json");
  await deps.objects.put(htmlKey, html, "text/html; charset=utf-8");
  if (!receipt.cardToken) return;
  const png = await renderCardPng(lines, agentTitle(lines, receipt.timeZone, receipt.session.startedAt, receipt.session.checkedAt, receipt.agentName), "SESSION DIFF");
  await deps.objects.putBytes(receiptCardKey(jsonKey), png, "image/png");
}

export async function getReceipt(deps: CoreDeps, receiptId: string): Promise<{ receipt: Receipt; html: string; meta: ReceiptMeta }> {
  const meta = await deps.meta.getReceipt(deps.userId, receiptId);
  if (!meta) throw new AppError("No receipt with that id.");
  const json = await deps.objects.get(meta.jsonKey);
  const html = await deps.objects.get(meta.htmlKey);
  if (!json || !html) throw new AppError("That receipt is no longer stored.");
  return { receipt: redactStrings(JSON.parse(json) as Receipt), html: redactText(html), meta };
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
