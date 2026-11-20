CREATE TABLE upstreams (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  auth_enc TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX idx_upstreams_user ON upstreams (user_id, created_at);
