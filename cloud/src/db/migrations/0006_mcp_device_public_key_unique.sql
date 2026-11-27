-- 设备注册并发加固（正式发版前安全审计 S1）：
-- 注册路径的「同公钥查重 + 5 台配额」原先是事务内 SELECT→INSERT，
-- 并发注册同公钥可产生重复 pending 行、并发注册可越过 5 台配额。
-- 唯一索引（排除 revoked：撤销后允许重新注册）把「同公钥同用户至多
-- 一台活设备」下沉为数据库约束；配额仍由应用层维护。
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_devices_user_pubkey_active_uq"
  ON "mcp_devices" ("user_id", "public_key")
  WHERE "status" <> 'revoked';
