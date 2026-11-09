/**
 * 跨模块通用文案。只放真正被多处复用的条目；模块专属文案放各自命名空间。
 */
export const common = {
  cancel: '取消',
  confirm: '确认',
  save: '保存',
  saving: '保存中…',
  delete: '删除',
  edit: '编辑',
  close: '关闭',
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败：请手动选择文本',
  loading: '加载中…',
  retry: '重试',
  search: '搜索',
  clear: '清除',
  all: '全部',
  none: '无',
  unknown: '未知',
  never: '从未',
  empty: '暂无内容',
  error: '出错了',
  count: (n: number) => `共 ${n} 条`,
  fileCount: (n: number) => `${n} 个文件`
}
