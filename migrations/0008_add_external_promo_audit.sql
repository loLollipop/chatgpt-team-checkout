ALTER TABLE cdks ADD COLUMN external_mode_at TEXT;
ALTER TABLE cdks ADD COLUMN external_use_count INTEGER NOT NULL DEFAULT 0
  CHECK (external_use_count >= 0);

CREATE TABLE IF NOT EXISTS cdk_checkout_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cdk_id INTEGER NOT NULL,
  encrypted_promo_code TEXT,
  promo_code_suffix TEXT NOT NULL DEFAULT '',
  promo_source TEXT NOT NULL CHECK (promo_source IN ('registered', 'external', 'none')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (cdk_id) REFERENCES cdks(id)
);

CREATE INDEX IF NOT EXISTS idx_cdk_checkout_audits_cdk_created
  ON cdk_checkout_audits(cdk_id, created_at DESC);
