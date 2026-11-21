ALTER TABLE user_settings ADD COLUMN idle_minutes INTEGER NOT NULL DEFAULT 20;
ALTER TABLE user_settings ADD COLUMN quiet_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN last_viewed_at TEXT;
