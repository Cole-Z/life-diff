export interface Env {
  DB: D1Database;
  RECEIPTS: R2Bucket;
  USER_SESSIONS: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  ISSUER: string;
  MCP_SERVER_URL: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_SLUG: string;
  TOKEN_ENCRYPTION_KEY: string;
  COOKIE_SIGNING_KEY: string;
  RECEIPT_RETENTION_DAYS: string;
  SNAPSHOT_RETENTION_HOURS: string;
  ABANDONED_SESSION_DAYS: string;
  MAX_REPOS: string;
  ENVIRONMENT: string;
  APPROVED_UPSTREAM_ENDPOINTS?: string;
  AUTH_SERVER?: AuthServerBinding;
}

export interface AuthProps {
  userId: string;
  login: string;
  accountVersion?: string;
}

export interface AuthServerBinding {
  validateToken(
    resource: string,
    token: string,
  ): Promise<{
    props: AuthProps;
    audience: string;
    expiresAt: number;
    scope: string[];
    userId: string;
    clientId: string;
  } | null>;
}

export interface Limits {
  receiptRetentionDays: number;
  snapshotRetentionHours: number;
  abandonedSessionDays: number;
  maxRepos: number;
}

export function limitsFromEnv(env: Env): Limits {
  return {
    receiptRetentionDays: positiveInt(env.RECEIPT_RETENTION_DAYS, 90),
    snapshotRetentionHours: positiveInt(env.SNAPSHOT_RETENTION_HOURS, 24),
    abandonedSessionDays: positiveInt(env.ABANDONED_SESSION_DAYS, 7),
    maxRepos: positiveInt(env.MAX_REPOS, 25),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
