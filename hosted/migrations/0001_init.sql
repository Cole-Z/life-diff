CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE github_credentials (
  user_id TEXT PRIMARY KEY,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  access_expires_at TEXT,
  refresh_expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE installations (
  user_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, installation_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_r2_key TEXT,
  snapshot_expires_at TEXT NOT NULL,
  receipt_id TEXT,
  time_zone TEXT NOT NULL,
  repo_count INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions (user_id, started_at DESC);
CREATE INDEX idx_sessions_snapshot_expiry ON sessions (snapshot_expires_at);
CREATE INDEX idx_sessions_status ON sessions (status, snapshot_expires_at);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  json_r2_key TEXT NOT NULL,
  html_r2_key TEXT NOT NULL,
  added INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  modified INTEGER NOT NULL,
  verified_claims INTEGER NOT NULL,
  missing_claims INTEGER NOT NULL,
  unclaimed_changes INTEGER NOT NULL
);

CREATE INDEX idx_receipts_user ON receipts (user_id, created_at DESC);
CREATE INDEX idx_receipts_expires ON receipts (expires_at);
