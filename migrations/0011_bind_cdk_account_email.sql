-- 客户 CDK 首次成功提链后绑定 Session 邮箱的带密钥指纹；
-- 不保存或展示邮箱明文，历史 CDK 在下一次成功提链时自动绑定。
ALTER TABLE cdks ADD COLUMN bound_email_hash TEXT;
