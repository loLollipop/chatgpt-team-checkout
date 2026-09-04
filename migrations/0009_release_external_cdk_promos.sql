-- 0008 上线后已经成功使用客户自有优惠码的 CDK，
-- 立即解除原库存优惠码绑定；未售出的优惠码将自动回到可分配库存。
DELETE FROM cdk_promo_assignments
WHERE cdk_id IN (
  SELECT id FROM cdks
  WHERE kind = 'standard' AND external_mode_at IS NOT NULL
);
