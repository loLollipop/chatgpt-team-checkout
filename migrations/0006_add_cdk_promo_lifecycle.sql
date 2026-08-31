ALTER TABLE cdks ADD COLUMN activated_at TEXT;
ALTER TABLE cdks ADD COLUMN deleted_at TEXT;

-- 旧版普通 CDK 已经开始计算 24 小时有效期，标记为已激活并保留原次数限制；
-- 迁移后新生成的普通 CDK 使用 2147483647 作为可重复哨兵，兼容旧表 max_uses > 0 约束。
UPDATE cdks
SET activated_at = COALESCE(last_used_at, created_at)
WHERE kind = 'standard' AND activated_at IS NULL;

ALTER TABLE promo_codes ADD COLUMN redeemed_at TEXT;
ALTER TABLE promo_codes ADD COLUMN auto_delete_at TEXT;

CREATE INDEX IF NOT EXISTS idx_cdks_deleted_id
  ON cdks(deleted_at, id DESC);

CREATE INDEX IF NOT EXISTS idx_promo_codes_auto_delete
  ON promo_codes(deleted_at, auto_delete_at);
