CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  encrypted_code TEXT NOT NULL,
  code_suffix TEXT NOT NULL,
  country TEXT NOT NULL,
  batch_name TEXT NOT NULL DEFAULT '',
  imported_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS cdk_promo_assignments (
  cdk_id INTEGER NOT NULL UNIQUE,
  promo_code_id INTEGER NOT NULL UNIQUE,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (cdk_id, promo_code_id),
  FOREIGN KEY (cdk_id) REFERENCES cdks(id),
  FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id)
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_country_available
  ON promo_codes(country, deleted_at, id);

CREATE INDEX IF NOT EXISTS idx_cdk_promo_assignments_promo
  ON cdk_promo_assignments(promo_code_id);
