#!/usr/bin/env bash
# BrewPhase Cloud CI — 断言辅助（Phase 1.3.3-A-R5-R3.3）
#
# 只被 `.github/workflows/cloud-ci.yml` `source`，不参与构建、不进镜像。
#
# 这里解决三类「假通过」：
#
#   1. **只判非零退出**：docker/compose 自己失败（125/126/127、镜像不存在、
#      服务名写错）同样是非零，会被误当成「预检正确拒绝了配置」；
#   2. **先打印日志再扫 Secret**：一旦日志里真出现口令，CI 会先把明文打进
#      Actions 记录，再报「泄漏」——为时已晚；
#   3. **Secret 名单散落在 workflow 里**：新增一个环境变量就漏扫一个。
#
# 因此约定：
#   - 所有测试 Secret 只在 `CI_TEST_SECRETS` 一处维护；
#   - 断言顺序固定为「扫 Secret → 判退出码 → 判错误码/原因」；
#   - 诊断输出一律走 `ci_print_diagnostics`（逐行脱敏），不允许 `cat` 原始日志。

# ── 单一维护点：CI 临时配置里的全部敏感测试值 ────────────────────────────────
#
# 与 workflow 里 `Create temporary .env.production` 写入的值逐字对应。
# **新增敏感环境变量时只改这里**：漏加等于泄漏扫描静默失效。
#
# 注意：故意用完整值而不是前缀。前缀会漏掉「只打印了后半段」的形态，
# 而完整值能命中任何包含它的输出（包括被截断在中间的情况）。
CI_TEST_SECRETS=(
  "7c1f0b9d4e2a6835fa91c0d7e5b32468"          # POSTGRES_PASSWORD（同时出现在 DATABASE_URL 里）
  "ci_r5r3_jwt_key_0123456789abcdefghijklmnop" # JWT_SIGNING_KEY
  "ci_r5r3_pepper_0123456789"                  # SESSION_TOKEN_PEPPER（R5-R3.3 补）
  "ci_r5r3_mcp_key_0123456789abcdef"           # MCP_BROWSER_SESSION_KEY
  "ci_r5r3_google_secret_0123456789"           # GOOGLE_CLIENT_SECRET
  "ci_r5r3_github_secret_0123456789"           # GITHUB_CLIENT_SECRET
  "ab/cdEfGhIjKlMnOpQrStUvWx"                  # 负例专用：含 `/` 的口令（预检应拒绝）
)

# 负例 (e) 注入用：同时覆盖 POSTGRES_PASSWORD 与 DATABASE_URL，
# 让 `postgres_password_unsafe_chars` 与 `database_url_invalid` 同时成立。
# 定义在这里而不是 workflow 里，避免「名单」与「注入值」各写一份、日后漂移。
CI_UNSAFE_TEST_PASSWORD="ab/cdEfGhIjKlMnOpQrStUvWx"

# 预检自身拒绝配置时的退出码。docker/compose 的基础设施错误是 125/126/127，
# 容器里被信号杀掉是 137/143——都不等于 1，因此不会被误判成「正确拒绝」。
readonly CI_PREFLIGHT_REJECT_EXIT=1

# 预检失败时的固定横幅（`main()` 里打印）。用它区分「我们的脚本真的跑了」
# 与「compose 自己挂了但恰好也返回 1」。
readonly CI_PREFLIGHT_FAILURE_BANNER="[preflight:remote-mcp] FAILED"

# 日志里是否出现了任一测试 Secret。命中返回 0。
ci_log_leaks_secret() {
  local log="$1"
  local secret
  for secret in "${CI_TEST_SECRETS[@]}"; do
    if grep -Fq -- "$secret" "$log"; then
      return 0
    fi
  done
  return 1
}

# 打印**已脱敏**的日志尾部（最多 40 行）。
#
# 不假定「预检永远不会打印值」：任何一处 message 拼进了配置值，这里都会先
# 替换成 ***REDACTED*** 再输出。真出现未知格式的敏感值时，`ci_log_leaks_secret`
# 会先拦住整条路径（调用方不会走到这里）。
ci_print_diagnostics() {
  local log="$1"
  local line
  local secret

  if [ ! -f "$log" ]; then
    echo "----- no log at ${log} -----"
    return 0
  fi

  echo "----- (redacted) ${log} — last 40 lines -----"
  while IFS= read -r line; do
    for secret in "${CI_TEST_SECRETS[@]}"; do
      line="${line//"$secret"/***REDACTED***}"
    done
    printf '%s\n' "$line"
  done < <(tail -n 40 "$log")
  echo "----- end of redacted log -----"
}

# 断言某份日志里没有测试 Secret。用于迁移日志等**不产生错误码**的场景。
assert_no_secret_in_log() {
  local log="$1"
  local label="$2"

  if [ ! -f "$log" ]; then
    echo "::error::${label}: log not found (${log}) — the step never ran"
    return 1
  fi
  if ci_log_leaks_secret "$log"; then
    # 关键：发现泄漏时**不输出日志内容**，只报事实。
    echo "::error::${label}: log leaked a test secret; content suppressed"
    return 1
  fi
  return 0
}

# 断言「命令按预期拒绝，且原因是某个错误码」。
#
# 判定顺序（不可调换）：
#   1. Secret 扫描——泄漏即失败，且**不输出原始日志**；
#   2. 退出码必须恰好是 `CI_PREFLIGHT_REJECT_EXIT`（1）；
#   3. 必须出现预检横幅（证明容器里跑的确实是我们的脚本）；
#   4. 必须出现每个预期错误码 `[code]`。
#
# 用法：expect_preflight_failure <日志路径> <错误码[,错误码…]> <命令…>
expect_preflight_failure() {
  local log="$1"
  local codes_csv="$2"
  shift 2

  local status=0
  # `|| status=$?` 而不是 `set +e`：只在这一条命令上捕获退出码，
  # 步骤其余部分仍然受 `-e` 保护。
  "$@" >"$log" 2>&1 || status=$?

  if ci_log_leaks_secret "$log"; then
    echo "::error::preflight output leaked a test secret — log suppressed"
    return 1
  fi

  if [ "$status" -ne "$CI_PREFLIGHT_REJECT_EXIT" ]; then
    echo "::error::preflight exited ${status}, expected ${CI_PREFLIGHT_REJECT_EXIT}"
    echo "  (0 = the config was accepted; 125/126/127 = docker/compose failed; 137/143 = killed)"
    ci_print_diagnostics "$log"
    return 1
  fi

  if ! grep -Fq -- "$CI_PREFLIGHT_FAILURE_BANNER" "$log"; then
    echo "::error::exit ${status} without the preflight failure banner — the preflight never ran"
    ci_print_diagnostics "$log"
    return 1
  fi

  local code
  for code in ${codes_csv//,/ }; do
    if ! grep -Fq -- "[$code]" "$log"; then
      echo "::error::expected error code [$code] not found in preflight output"
      ci_print_diagnostics "$log"
      return 1
    fi
  done

  return 0
}

# 断言「命令按预期失败，且失败原因包含指定文本」。用于 `caddy validate`。
#
# 用法：expect_failure_with_reason <日志路径> <失败原因片段> <命令…>
expect_failure_with_reason() {
  local log="$1"
  local needle="$2"
  shift 2

  local status=0
  "$@" >"$log" 2>&1 || status=$?

  if ci_log_leaks_secret "$log"; then
    echo "::error::failure output leaked a test secret — log suppressed"
    return 1
  fi

  if [ "$status" -eq 0 ]; then
    echo "::error::command unexpectedly SUCCEEDED (expected failure: ${needle})"
    ci_print_diagnostics "$log"
    return 1
  fi

  if ! grep -Fq -- "$needle" "$log"; then
    echo "::error::command failed for an unexpected reason (want: ${needle})"
    ci_print_diagnostics "$log"
    return 1
  fi

  return 0
}
