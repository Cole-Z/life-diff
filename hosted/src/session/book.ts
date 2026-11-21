export interface OpenSession {
  id: string;
  startedAt: string;
  snapshotId: string;
  snapshotKey: string;
  timeZone: string;
  repos: string[];
  warnings: string[];
  /** The user named these repositories for this session. */
  githubOptIn?: boolean;
  /** Last proxied call or start. Idle close uses this, then startedAt. */
  activityAt?: string;
}

export type ActionSource = "proxy" | "claim";
export type StoredEffect = "read" | "write" | "unknown";
export type StoredTone = "created" | "changed" | "removed" | "read" | "unknown";

export interface LoggedAction {
  id: string;
  sessionId: string;
  loggedAt: string;
  tool: string;
  action?: string;
  target: string;
  detail?: string;
  resource?: string;
  repo?: string;
  source?: ActionSource;
  upstream?: string;
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  durationMs?: number;
  effect?: StoredEffect;
  tone?: StoredTone;
  verb?: string;
  summary?: string;
  status?: string;
  result?: string;
  client?: string;
}

export interface NewAction {
  id: string;
  loggedAt: string;
  tool: string;
  action?: string;
  target: string;
  detail?: string;
  resource?: string;
  repo?: string;
  source?: ActionSource;
  upstream?: string;
  arguments?: unknown;
  ok?: boolean;
  error?: string;
  durationMs?: number;
  effect?: StoredEffect;
  tone?: StoredTone;
  verb?: string;
  summary?: string;
  status?: string;
  result?: string;
  client?: string;
}

export interface SessionState {
  open: OpenSession | null;
  actions: LoggedAction[];
  /** Set while one closer is building the receipt. A second closer must not build another. */
  closingId?: string;
  closingAt?: number;
}

export type CloseClaim =
  | { status: "claimed"; session: OpenSession; actions: LoggedAction[] }
  | { status: "busy"; sessionId: string }
  | { status: "idle" }
  | { status: "mismatch" };

const CLOSE_CLAIM_MS = 30_000;

export const MAX_ACTIONS = 500;

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export class SessionBook {
  private state: SessionState;

  constructor(state?: SessionState) {
    this.state = state ?? { open: null, actions: [] };
  }

  static fromUnknown(raw: unknown): SessionBook {
    return new SessionBook(parseState(raw));
  }

  toJSON(): SessionState {
    return {
      open: this.state.open ? { ...this.state.open, repos: [...this.state.open.repos], warnings: [...this.state.open.warnings] } : null,
      actions: this.state.actions.map((action) => copyAction(action)),
      ...(this.state.closingId ? { closingId: this.state.closingId } : {}),
      ...(typeof this.state.closingAt === "number" ? { closingAt: this.state.closingAt } : {}),
    };
  }

  getOpen(): OpenSession | null {
    return this.state.open ? { ...this.state.open } : null;
  }

  start(session: OpenSession): OpenSession {
    this.dropStaleClaim();
    if (this.state.open || this.state.closingId) {
      throw new SessionError("A session is already open. Call end_session before starting another.");
    }
    this.state.open = { ...session, repos: [...session.repos], warnings: [...session.warnings] };
    this.state.actions = [];
    return this.getOpen() as OpenSession;
  }

  log(sessionId: string, action: NewAction): LoggedAction {
    if (this.state.closingId === sessionId) {
      throw new SessionError("That session is closing.");
    }
    const open = this.requireOpen(sessionId);
    if (this.state.actions.length >= MAX_ACTIONS) {
      throw new SessionError(`This session already has ${MAX_ACTIONS} logged actions.`);
    }
    const stored = copyAction({
      ...action,
      sessionId: open.id,
    });
    this.state.actions.push(stored);
    this.state.open = { ...open, activityAt: action.loggedAt };
    return { ...stored };
  }

  touch(sessionId: string, at: string): void {
    if (this.state.open?.id !== sessionId) return;
    this.state.open = { ...this.state.open, activityAt: at };
  }

  list(sessionId: string): LoggedAction[] {
    this.requireOpen(sessionId);
    return this.state.actions.filter((action) => action.sessionId === sessionId).map((action) => copyAction(action));
  }

  close(sessionId: string): void {
    this.requireOpen(sessionId);
    this.state.open = null;
    this.state.actions = [];
    this.clearClaim(sessionId);
  }

  /**
   * One closer wins. The open session stays readable until `close`, so a daily
   * diff can still show it as in progress, but a second closer gets `busy`.
   */
  claimClose(sessionId?: string): CloseClaim {
    this.dropStaleClaim();
    const held = this.state.closingId;
    if (held) {
      if (!sessionId || sessionId === held) return { status: "busy", sessionId: held };
      return { status: "mismatch" };
    }
    const open = this.state.open;
    if (!open) return { status: "idle" };
    if (sessionId && sessionId !== open.id) return { status: "mismatch" };
    this.state.closingId = open.id;
    this.state.closingAt = Date.now();
    return {
      status: "claimed",
      session: this.getOpen() as OpenSession,
      actions: this.state.actions.filter((action) => action.sessionId === open.id).map((action) => copyAction(action)),
    };
  }

  abortClose(sessionId: string): void {
    this.clearClaim(sessionId);
  }

  abandon(sessionId: string): void {
    if (this.state.open?.id === sessionId) this.close(sessionId);
  }

  wipe(): void {
    this.state = { open: null, actions: [] };
  }

  private clearClaim(sessionId: string): void {
    if (this.state.closingId !== sessionId) return;
    delete this.state.closingId;
    delete this.state.closingAt;
  }

  private dropStaleClaim(): void {
    if (!this.state.closingId) return;
    const at = this.state.closingAt;
    if (typeof at === "number" && Date.now() - at < CLOSE_CLAIM_MS) return;
    delete this.state.closingId;
    delete this.state.closingAt;
  }

  private requireOpen(sessionId: string): OpenSession {
    if (!this.state.open || this.state.open.id !== sessionId) {
      throw new SessionError("That session is not open.");
    }
    return this.state.open;
  }
}

function parseState(raw: unknown): SessionState {
  if (!raw || typeof raw !== "object") return { open: null, actions: [] };
  const record = raw as { open?: unknown; actions?: unknown; closingId?: unknown; closingAt?: unknown };
  return {
    open: parseOpen(record.open),
    ...(typeof record.closingId === "string" ? { closingId: record.closingId } : {}),
    ...(typeof record.closingAt === "number" ? { closingAt: record.closingAt } : {}),
    actions: Array.isArray(record.actions) ? record.actions.flatMap((item) => {
      const action = parseAction(item);
      return action ? [action] : [];
    }) : [],
  };
}

function parseOpen(raw: unknown): OpenSession | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.startedAt !== "string" || typeof record.snapshotId !== "string") return null;
  return {
    id: record.id,
    startedAt: record.startedAt,
    snapshotId: record.snapshotId,
    snapshotKey: typeof record.snapshotKey === "string" ? record.snapshotKey : "",
    timeZone: typeof record.timeZone === "string" ? record.timeZone : "UTC",
    repos: Array.isArray(record.repos) ? record.repos.filter((item): item is string => typeof item === "string") : [],
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === "string") : [],
    ...(record.githubOptIn === true ? { githubOptIn: true } : {}),
    ...(typeof record.activityAt === "string" ? { activityAt: record.activityAt } : {}),
  };
}

function parseAction(raw: unknown): LoggedAction | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.sessionId !== "string" || typeof record.target !== "string" || typeof record.tool !== "string") {
    return null;
  }
  return copyAction({
    id: record.id,
    sessionId: record.sessionId,
    loggedAt: typeof record.loggedAt === "string" ? record.loggedAt : "",
    tool: record.tool,
    target: record.target,
    ...(typeof record.action === "string" ? { action: record.action } : {}),
    ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    ...(typeof record.resource === "string" ? { resource: record.resource } : {}),
    ...(typeof record.repo === "string" ? { repo: record.repo } : {}),
    ...(record.source === "proxy" || record.source === "claim" ? { source: record.source } : {}),
    ...(typeof record.upstream === "string" ? { upstream: record.upstream } : {}),
    ...(record.arguments !== undefined ? { arguments: record.arguments } : {}),
    ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
    ...(record.effect === "read" || record.effect === "write" || record.effect === "unknown" ? { effect: record.effect } : {}),
    ...(record.tone === "created" || record.tone === "changed" || record.tone === "removed" || record.tone === "read" || record.tone === "unknown" ? { tone: record.tone } : {}),
    ...(typeof record.verb === "string" ? { verb: record.verb } : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.result === "string" ? { result: record.result } : {}),
    ...(typeof record.client === "string" ? { client: record.client } : {}),
  });
}

function copyAction(action: LoggedAction): LoggedAction {
  return {
    id: action.id,
    sessionId: action.sessionId,
    loggedAt: action.loggedAt,
    tool: action.tool,
    target: action.target,
    ...(action.action ? { action: action.action } : {}),
    ...(action.detail ? { detail: action.detail } : {}),
    ...(action.resource ? { resource: action.resource } : {}),
    ...(action.repo ? { repo: action.repo } : {}),
    ...(action.source ? { source: action.source } : {}),
    ...(action.upstream ? { upstream: action.upstream } : {}),
    ...(action.arguments !== undefined ? { arguments: action.arguments } : {}),
    ...(typeof action.ok === "boolean" ? { ok: action.ok } : {}),
    ...(action.error ? { error: action.error } : {}),
    ...(typeof action.durationMs === "number" ? { durationMs: action.durationMs } : {}),
    ...(action.effect ? { effect: action.effect } : {}),
    ...(action.tone ? { tone: action.tone } : {}),
    ...(action.verb ? { verb: action.verb } : {}),
    ...(action.summary ? { summary: action.summary } : {}),
    ...(action.status ? { status: action.status } : {}),
    ...(action.result ? { result: action.result } : {}),
    ...(action.client ? { client: action.client } : {}),
  };
}
