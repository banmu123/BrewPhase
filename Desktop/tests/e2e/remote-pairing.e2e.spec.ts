import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { pinLocale } from './locale'

/**
 * 远程访问面板的配对状态 E2E（R5-R3.4.1 §10 / §11 UI 组）。
 *
 * 用**全新 userData**（没有登录态、没有 Cloud origin），所以 `register()`
 * 只可能诚实地失败。这正是要钉住的性质：
 *
 * 1. 没有任何凭据时，页面上**不出现**「配对完成」；
 * 2. 没有设备时「忘记此设备」是禁用的；
 * 3. 点「配对新设备」之后仍然不出现「配对完成」，也不出现伪造的
 *    pending 卡片——失败要以失败的样子呈现。
 *
 * 更细的状态机（单飞、领取结局、按钮禁用判据）在
 * `tests/unit/remote-pairing-view.test.ts` 与
 * `tests/integration/remote-pairing-race.test.ts` 里覆盖：那两组能在毫秒级
 * 编排并发时序，E2E 只负责证明「真实应用里这套规则真的生效」。
 *
 * 前置：`pnpm build && pnpm mcp:build`。
 */
test('远程访问：没有凭据就不显示配对完成，也不会伪造成功', async () => {
  test.setTimeout(90_000)
  const userData = mkdtempSync(join(tmpdir(), 'brewphase-remote-pairing-e2e-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BREWPHASE_USER_DATA_DIR: userData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], env })
  try {
    const page = await app.firstWindow()
    await pinLocale(page, 'zh-CN')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: 'AI 连接', exact: true }).click()

    const register = page.getByTestId('remote-register')
    await expect(register).toBeVisible()
    // 断言全部限定在「远程访问」这个 section 内：页面上别的区块也可能有
    // `.settings-error`，不限定作用域的话，那条断言会被别处的错误误判成通过。
    const section = page.locator('section.settings-subsection').filter({ has: register })
    const errors = section.locator('.settings-error')

    // 没有设备 → 可以开始配对，但「忘记此设备」必须是禁用的。
    await expect(register).toBeEnabled()
    await expect(page.getByRole('button', { name: '忘记此设备' })).toBeDisabled()

    // 还没有任何凭据：整页不得出现「配对完成」。
    await expect(page.getByText('配对完成')).toHaveCount(0)
    // 也不该有待确认卡片（没有 pending），更不该编造「先去确认/忘记设备」的提示。
    await expect(page.getByTestId('remote-pending-device')).toHaveCount(0)
    await expect(page.getByTestId('remote-pairing-blocker')).toHaveCount(0)
    await expect(errors).toHaveCount(0)

    // 点下去只会得到诚实的失败（全新档案没有登录态 / Cloud origin）。
    await register.click()
    await expect(errors.first()).toBeVisible()

    // 关键四条：不伪造 pending、不伪造「配对完成」、不伪造确认按钮、不编造阻塞提示。
    await expect(page.getByTestId('remote-pending-device')).toHaveCount(0)
    await expect(page.getByText('配对完成')).toHaveCount(0)
    await expect(page.getByTestId('remote-pairing-notice')).toHaveCount(0)
    await expect(page.getByTestId('remote-confirm-device')).toHaveCount(0)
    await expect(page.getByTestId('remote-pairing-blocker')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
