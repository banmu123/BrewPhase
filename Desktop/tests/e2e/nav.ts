import type { Page } from '@playwright/test'

/**
 * 空间导航：Studio Desk 之后没有固定侧栏，也没有全局空间 Tab。
 * 三个空间只能从 Studio 首页的内容入口进入，所以「去另一个空间」=
 * 先回 Studio（空间页头的返回入口 / 顶栏品牌），再点那个空间的入口。
 *
 * 已经在 Studio 首页时直接点，不做多余跳转。
 */
export async function openSpace(page: Page, name: string): Promise<void> {
  if ((await page.locator('.studio-home').count()) === 0) {
    const back = page.locator('.back-link')
    if ((await back.count()) > 0) {
      await back.first().click()
    } else if ((await page.locator('.canvas-back').count()) > 0) {
      // 画布工作区隐藏了全局顶栏：先退回 Gallery，再回 Studio。
      await page.locator('.canvas-back').first().click()
      await page.locator('.topbar__brand').click()
    } else {
      // 设置页没有空间页头，走品牌回首页。
      await page.locator('.topbar__brand').click()
    }
  }
  await page.getByRole('button', { name, exact: true }).click()
}
