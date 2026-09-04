-- 每个仅 CDK 模式客户默认可成功提链 3 次；
-- 管理员充值时只增加上限，保留真实的累计使用次数。
ALTER TABLE cdks ADD COLUMN external_use_limit INTEGER NOT NULL DEFAULT 3
  CHECK (external_use_limit >= 3);
