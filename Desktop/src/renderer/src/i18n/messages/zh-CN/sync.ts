/** 设备同步（局域网配对、设备撤销、冲突裁决）。 */
export const sync = {
  overline: '设备同步',
  headline: 'iPhone 记录的内容，回到电脑就在这里。',
  enable: '启用局域网同步',
  disable: '停用局域网同步',
  pairNew: '连接新手机',
  running: (port: number, address: string) => `运行中 · 端口 ${port} · ${address}`,
  startFailed: '服务未能启动',
  pairing: {
    alt: '配对二维码',
    scanHint: '用 BrewPhase iOS 扫码',
    instructions: '在 iPhone 的「更多 → 桌面同步」里打开相机扫描。配对码两分钟内有效、只能使用一次。',
    expiresIn: (clock: string) => `${clock} 后失效`,
    regenerate: '换一个码'
  },
  devices: {
    title: '已配对设备',
    empty: '还没有配对的设备。',
    lastSync: (when: string) => `上次同步 ${when}`,
    revoke: '撤销授权',
    revokeExplain:
      '撤销后这台手机不能再同步。也可以同时清空它同步过来的内容：记录、标签、画布、媒体文件，以及全部咖啡数据——豆子、冲煮、品鉴（包括在 Mac 上录入的）都会被删除。清空不可恢复。',
    cancel: '取消',
    revokeOnly: '只撤销授权',
    revokeAndWipe: '撤销并清空内容',
    wiped: (
      records: number,
      tags: number,
      canvases: number,
      beans: number,
      brews: number,
      tastings: number,
      media: number
    ) =>
      `已清空 ${records} 条记录、${tags} 个标签、${canvases} 块画布、${beans} 包豆子（含 ${brews} 次冲煮、${tastings} 次品鉴）、${media} 个媒体文件`
  },
  conflicts: {
    title: '冲突',
    titleWithCount: (n: number) => `冲突 · ${n}`,
    empty: '同一份数据在两端都被修改时会停在这里等你裁决，绝不静默覆盖。',
    deleteExplain: '手机端删除了这条记录，但电脑端修改过它。保留则两端各留一份；接受将删除电脑端的这条记录。',
    keepLocal: '保留电脑版本',
    acceptDelete: '接受删除',
    acceptRemote: '接受手机版本',
    confirmDelete: '确认删除电脑端的这条记录？（手机端已删除）'
  }
}
