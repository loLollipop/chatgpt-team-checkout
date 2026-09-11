-- 区分客户 CDK 的发放方式；历史记录均来自原有自动分配流程。
ALTER TABLE cdks ADD COLUMN issue_mode TEXT NOT NULL DEFAULT 'with_promo'
  CHECK (issue_mode IN ('with_promo', 'cdk_only'));
