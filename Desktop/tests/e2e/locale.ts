import type { Page } from '@playwright/test'

/**
 * 给 e2e 固定界面语言。
 *
 * 渲染层的语言来自 localStorage > 系统语言；测试机与 CI 的系统语言不会一致，
 * 所以每个 spec 在 firstWindow 之后显式钉住语言，再 reload 让 Provider 重新取值。
 * 这样断言可以稳定使用某一语言的文案，而不依赖运行环境。
 */
export async function pinLocale(page: Page, locale: 'zh-CN' | 'en-US' = 'zh-CN'): Promise<void> {
  await page.addInitScript((value: string) => {
    window.localStorage.setItem('brewphase.desktop.locale', value)
  }, locale)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
}
