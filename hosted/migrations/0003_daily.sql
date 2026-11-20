ALTER TABLE sessions ADD COLUMN github_opt_in INTEGER NOT NULL DEFAULT 0;

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY,
  time_zone TEXT NOT NULL DEFAULT 'America/Chicago',
  day_end TEXT NOT NULL DEFAULT '18:00',
  github_daily INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE daily_diffs (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  finalized_at TEXT,
  json_r2_key TEXT NOT NULL,
  html_r2_key TEXT NOT NULL,
  card_r2_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX idx_daily_diffs_day ON daily_diffs (day);
