import { dialog } from 'electron'
import {
  clearDataLocation,
  migrateDataDirectory,
  resolveDataLocation,
  validateDataTarget,
  writeDataLocation,
  type DataLocationStatus
} from './data-location'
import type { DataLocationChangeResult } from '../shared/contracts/data-location'

/**
 * 数据位置的选择与迁移编排。
 *
 * 顺序固定：校验目标（不碰当前数据）→ 关闭数据库/本地服务 → 复制 →
 * 写配置 → 由调用方重启。任何一步失败都不会写配置，原数据保持原样。
 */
export class DataLocationService {
  constructor(
    private readonly options: {
      userDataDir: string
      appPath: string
      /** 复制前关闭数据库、bridge 与原生浏览器；之后应用只能重启。 */
      onBeforeMigrate: () => Promise<void>
      relaunch: () => void
    }
  ) {}

  status(): DataLocationStatus {
    return resolveDataLocation(this.options.userDataDir)
  }

  async choose(): Promise<DataLocationChangeResult> {
    const before = this.status()

    // E2E / 便携：用环境变量指定目录，不弹系统对话框。
    const preset = process.env.BREWPHASE_DATA_DIR_CHOICE
    let target = preset
    if (!target) {
      const result = await dialog.showOpenDialog({
        title: '选择 BrewPhase 数据目录',
        buttonLabel: '使用这个目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true, status: before }
      }
      target = result.filePaths[0]
    }

    const check = validateDataTarget(target, before.dataDir, this.options.appPath)
    if (!check.ok) {
      return { ok: false, message: check.reason, status: before }
    }

    await this.options.onBeforeMigrate()

    const migration = await migrateDataDirectory(before.dataDir, target)
    if (!migration.ok) {
      return {
        ok: false,
        // 开始复制前已经关闭数据库/本地服务：必须重启才能回到可用状态。
        requiresRestart: true,
        message: migration.reason,
        status: this.status()
      }
    }

    try {
      await writeDataLocation(this.options.userDataDir, migration.dataDir)
    } catch (error) {
      return {
        ok: false,
        requiresRestart: true,
        message: error instanceof Error ? error.message : 'could not save the new location',
        status: this.status()
      }
    }

    return {
      ok: true,
      dataDir: migration.dataDir,
      requiresRestart: true,
      status: this.status()
    }
  }

  /** 切回默认位置；不搬动数据，也不删除自定义目录里的副本。 */
  async reset(): Promise<DataLocationChangeResult> {
    await clearDataLocation(this.options.userDataDir)
    return { ok: true, requiresRestart: true, status: this.status() }
  }

  relaunch(): void {
    this.options.relaunch()
  }
}
