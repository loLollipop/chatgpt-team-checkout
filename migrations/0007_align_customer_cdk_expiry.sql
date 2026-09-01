-- 普通可重复 CDK 默认激活 24 小时；若绑定优惠码已经开始 24 小时清理计时，
-- CDK 结束时间与优惠码 auto_delete_at 精确对齐。
UPDATE cdks
SET expires_at = COALESCE(
  (
    SELECT p.auto_delete_at
    FROM cdk_promo_assignments a
    JOIN promo_codes p ON p.id = a.promo_code_id
    WHERE a.cdk_id = cdks.id AND p.auto_delete_at IS NOT NULL
    LIMIT 1
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', activated_at, '+24 hours')
)
WHERE kind = 'standard'
  AND max_uses = 2147483647
  AND activated_at IS NOT NULL
  AND deleted_at IS NULL
  AND revoked_at IS NULL;
