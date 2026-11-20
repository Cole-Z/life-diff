export interface OpenSession {
  id: string;
  startedAt: string;
  snapshotId: string;
  snapshotKey: string;
  timeZone: string;
  repos: string[];
  warnings: string[];
}

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
}

export interface SessionState {
  open: OpenSession | null;
  actions: LoggedAction[];
}

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
      actions: this.state.actions.map((action) => ({ ...action })),
    };
  }

  getOpen(): OpenSession | null {
    return this.state.open ? { ...this.state.open } : null;
  }

  start(session: OpenSession): OpenSession {
    if (this.state.open) {
      throw new SessionError("A session is already open. Call end_session before starting another.");
    }
    this.state.open = { ...session, repos: [...session.repos], warnings: [...session.warnings] };
    this.state.actions = [];
    return this.getOpen() as OpenSession;
  }

  log(sessionId: string, action: NewAction): LoggedAction {
    const open = this.requireOpen(sessionId);
    if (this.state.actions.length >= MAX_ACTIONS) {
      throw new SessionError(`This session already has ${MAX_ACTIONS} logged actions.`);
    }
    const stored: LoggedAction = {
      id: action.id,
      sessionId: open.id,
      loggedAt: action.loggedAt,
      tool: action.tool,
      target: action.target,
      ...(action.action ? { action: action.action } : {}),
      ...(action.detail ? { detail: action.detail } : {}),
      ...(action.resource ? { resource: action.resource } : {}),
      ...(action.repo ? { repo: action.repo } : {}),
    };
    this.state.actions.push(stored);
    return { ...stored };
  }

  list(sessionId: string): LoggedAction[] {
    this.requireOpen(sessionId);
    return this.state.actions.filter((action) => action.sessionId === sessionId).map((action) => ({ ...action }));
  }

  close(sessionId: string): void {
    this.requireOpen(sessionId);
    this.state.open = null;
    this.state.actions = [];
  }

  abandon(sessionId: string): void {
    if (this.state.open?.id === sessionId) this.close(sessionId);
  }

  wipe(): void {
    this.state = { open: null, actions: [] };
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
  const record = raw as { open?: unknown; actions?: unknown };
  return {
    open: parseOpen(record.open),
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
  };
}

function parseAction(raw: unknown): LoggedAction | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.sessionId !== "string" || typeof record.target !== "string" || typeof record.tool !== "string") {
    return null;
  }
  return {
    id: record.id,
    sessionId: record.sessionId,
    loggedAt: typeof record.loggedAt === "string" ? record.loggedAt : "",
    tool: record.tool,
    target: record.target,
    ...(typeof record.action === "string" ? { action: record.action } : {}),
    ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    ...(typeof record.resource === "string" ? { resource: record.resource } : {}),
    ...(typeof record.repo === "string" ? { repo: record.repo } : {}),
  };
}
