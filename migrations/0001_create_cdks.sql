CREATE TABLE IF NOT EXISTS cdks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  code_suffix TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cdks_created_at ON cdks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cdks_active ON cdks(revoked_at, expires_at, use_count, max_uses);
