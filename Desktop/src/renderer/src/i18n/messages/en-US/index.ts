import type { Messages } from '../zh-CN'
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
 * English dictionary. `satisfies Messages` makes a missing or misspelled key a
 * compile error instead of a runtime `undefined`.
 */
export const enUS = {
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
} satisfies Messages
