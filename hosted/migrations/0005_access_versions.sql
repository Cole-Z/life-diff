-- Empty versions preserve existing browser sessions and MCP grants for current accounts.
-- New accounts get fresh versions, and clearing history rotates only history access.
ALTER TABLE users ADD COLUMN account_version TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN history_version TEXT NOT NULL DEFAULT '';
