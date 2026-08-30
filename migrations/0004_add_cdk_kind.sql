ALTER TABLE cdks
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard'
  CHECK (kind IN ('standard', 'admin'));

UPDATE cdks
SET max_uses = 1,
    expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+24 hours')
WHERE kind = 'standard';

CREATE INDEX IF NOT EXISTS idx_cdks_kind_active
  ON cdks(kind, revoked_at, expires_at, use_count, max_uses);

CREATE INDEX IF NOT EXISTS idx_promo_codes_global_available
  ON promo_codes(deleted_at, id);
