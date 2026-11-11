import { canvas } from './canvas'
import { coffee } from './coffee'
import { common } from './common'
import { mcp } from './mcp'
import { navigation } from './navigation'
import { onboarding } from './onboarding'
import { records } from './records'
import { settings } from './settings'
import { studio } from './studio'
import { sync } from './sync'

/**
 * 简体中文字典 —— **类型基准**。`Messages` 由这份对象推断，
 * en-US 用 `satisfies Messages` 保证键集与函数签名完全一致。
 */
export const zhCN = {
  common,
  navigation,
  coffee,
  records,
  canvas,
  settings,
  sync,
  mcp,
  onboarding,
  studio
}

export type Messages = typeof zhCN
