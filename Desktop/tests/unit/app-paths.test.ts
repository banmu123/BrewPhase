import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGED_USER_DATA_NAME, resolveUserDataDir } from '../../src/main/paths'

/**
 * 守护「新下载的桌面端不该带着开发数据」这条边界：正式安装必须用独立
 * userData，开发态与 e2e 保持默认库，测试覆盖变量优先级最高。
 */
describe('resolveUserDataDir', () => {
  const appData = '/Users/banmu/Library/Application Support'

  it('打包版切到产品名目录，不落在 dev 的 brewphase-desktop', () => {
    expect(resolveUserDataDir(appData, true)).toBe(join(appData, PACKAGED_USER_DATA_NAME))
    expect(resolveUserDataDir(appData, true)).not.toContain('brewphase-desktop')
  })

  it('开发态沿用 Electron 默认目录（e2e 跑在真实库上）', () => {
    expect(resolveUserDataDir(appData, false)).toBeNull()
  })

  it('BREWPHASE_USER_DATA_DIR 覆盖两种构建形态', () => {
    const override = '/tmp/bp-e2e-data'
    expect(resolveUserDataDir(appData, false, override)).toBe(override)
    expect(resolveUserDataDir(appData, true, override)).toBe(override)
  })

  it('空字符串不算覆盖，避免环境变量存在但为空时丢掉隔离', () => {
    expect(resolveUserDataDir(appData, false, '')).toBeNull()
    expect(resolveUserDataDir(appData, true, '')).toBe(join(appData, PACKAGED_USER_DATA_NAME))
  })

  it('Windows / Linux 的 appData 一样按平台分隔符拼接', () => {
    expect(resolveUserDataDir('C:\\Users\\banmu\\AppData\\Roaming', true)).toBe(
      join('C:\\Users\\banmu\\AppData\\Roaming', PACKAGED_USER_DATA_NAME)
    )
  })
})
