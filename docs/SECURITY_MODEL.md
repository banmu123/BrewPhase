# 安全模型

## 1. 进程边界

| 约束 | 落地位置 |
| --- | --- |
| `contextIsolation: true` | `src/main/window.ts` |
| `nodeIntegration: false` | 同上 |
| `sandbox: true` | 同上（preload 只能用 `electron` 的 bridge API） |
| 只暴露白名单 API | `src/preload/index.ts` 逐条列出，不透传 `ipcRenderer` |
| 窗口内不允许外部导航 | `will-navigate` + `setWindowOpenHandler`，外链交给系统浏览器 |
| CSP | 主进程下发响应头（开发放开 HMR，生产收紧） |

## 2. IPC

1. **sender 校验**：只接受主框架（`senderFrame.parent === null`），URL 必须是我们
   自己的页面（开发是 dev server，生产是 `file://`）。
2. **参数校验**：每个通道在 `ipcRequestSchemas` 里有 zod schema；不合法直接拒绝，
   脏参数不会进 SQL。
3. **错误最小化**：回给 renderer 的只有 message，不带栈、不带文件路径。
4. **不给通用能力**：没有 `fs:*`、没有 `db:*`、没有 `shell:*` 通道。

## 3. 媒体

- renderer 拿到的是**文件名**，不是绝对路径。
- 显示走 `bpmedia://media/<name>`：主进程用正则校验名字
  （`^[A-Za-z0-9_-]{8,64}(_thumb)?\.(jpg|png|webp)$`），拼不出 `../`。
- 导入只走系统文件对话框；渲染进程无法指定任意路径。
- 单张图片上限 40MB；展示图与缩略图由主进程重新编码，原文件不动。

## 4. 数据

- 本地 SQLite + 媒体目录；不需要登录，不上传。
- 库打不开就停住，**不做「删库重建」兜底**（那是把用户数据当缓存）。
- 写操作全部在事务里；失败回滚，不留半条数据。

## 5. 同步（Phase 2 的安全前提）

- 一次性配对码 + 短期有效 + 用过即废；
- token 只存哈希；设备可撤销；
- 请求签名 + 时间窗 + nonce 去重（防重放）；
- 媒体逐块校验 SHA-256；
- 冲突上报给用户，不静默覆盖。

## 6. 这一版没有做的

- 没有代码签名与公证流程（`electron-builder` 配置留了位置，未接证书）；
- 没有自动更新；
- 没有对本地库加密（FDE 之外没有额外保护）。
