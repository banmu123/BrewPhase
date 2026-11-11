# Chrome Companion 集成设计

> 实现位置：`ChromeExtension/`、`Desktop/src/main/integrations/chrome/`、
> `Desktop/src/shared/contracts/chrome-bridge.ts`。
> 开发安装步骤见 `ChromeExtension/README.md`。

## 1. 为什么不是「共享 Session」

Electron 内置浏览器使用独立分区（`persist:brewphase-browser`），拿不到用户在
Chrome 里的登录态。复制 Cookie / Profile 会把账号凭据变成应用数据，也会让
Chrome 的加密与同步机制失效——安全与维护成本都不可接受。

Chrome Companion 换一条路：**Chrome 继续负责上网与登录，BrewPhase 只接收用户
主动送来的页面内容**。扩展不读 Cookie、不注入 Session、不做后台采集。

## 2. 数据流与信任边界

```text
用户点击扩展
  → popup: chrome.scripting.executeScript(readPageMetadata)
  → service worker: chrome.runtime.connectNative
  → Native Host: 读 4 字节长度 + JSON，原样转发
  → Desktop ChromeBridgeServer: 握手 token → Zod 校验 → 去重
  → RecordService.createFromChrome → createRecord（事务 + change_log）
  → 响应原路返回 → popup 显示结果
```

信任边界：

| 层 | 信任级别 | 能做什么 |
|---|---|---|
| 网页 | 不可信 | 只能提供标题/URL/meta/选区文本 |
| Popup | 半可信 | 只在 activeTab 下读当前页 |
| Service Worker | 半可信 | 只转发，不持久化 |
| Native Host | 半可信 | 只做帧与 IPC 转换，不解析业务字段 |
| Desktop | 可信 | 校验、落库、广播 |

网页内容永远不会被当作 HTML / 脚本执行；`url` 只接受 `http:` / `https:`。

## 3. 协议

### Chrome ↔ Host

Chrome 官方 Native Messaging 帧：

```text
[4 字节 native-endian 长度][UTF-8 JSON]
```

Host 侧上限 8 MB；超限只回 `INVALID_REQUEST` 并结束连接（无法安全跳过 body）。

### Host ↔ Desktop

NDJSON（一行一条），单行上限 256 KB。

握手（连接后第一行）：

```json
{"type":"hello","token":"<64 hex>","version":1}
```

Desktop 回复：

```json
{"type":"hello","ok":true,"appVersion":"0.1.1"}
```

`ok:false` 立即断开。token 来自 `host-config.json`，每次 Desktop 启动轮换。

请求：

```ts
type ChromeCompanionRequest = {
  version: 1
  requestId: string          // 1–100 字符，Desktop 用它做 5 分钟幂等
  type: 'PING' | 'SAVE_PAGE'
  payload?: {
    title: string            // ≤ 500
    url: string              // ≤ 2000，仅 http(s)
    domain: string           // ≤ 255，仅展示
    faviconUrl: string | null
    description: string      // ≤ 4000
    selectedText: string     // ≤ 20000
  }
}
```

响应：

```ts
type ChromeCompanionResponse = {
  version: 1
  requestId: string
  success: boolean
  code: 'OK' | 'APP_NOT_RUNNING' | 'INVALID_REQUEST' | 'UNSUPPORTED_URL'
      | 'SAVE_FAILED' | 'INTERNAL_ERROR'
  message?: string
  data?: { recordId?: string; appVersion?: string }
}
```

错误码与 Popup 文案：

| code | 触发 | Popup |
|---|---|---|
| `APP_NOT_RUNNING` | Host 连不上 Desktop / 握手失败 | 请先启动 BrewPhase Desktop |
| `INVALID_REQUEST` | JSON 坏、缺 payload、字段超限 | 保存失败，请重试 |
| `UNSUPPORTED_URL` | 非 http(s) | 当前网页暂不支持保存 |
| `SAVE_FAILED` | 数据库写入异常 | 保存失败，请重试 |
| `INTERNAL_ERROR` | 未预期异常 / 超时 | 保存失败，请重试 |
| `OK` | 成功 | 已保存到 BrewPhase Records |

## 4. Records 字段映射

第一版**不改表结构**：

| 页面字段 | Record 字段 | 说明 |
|---|---|---|
| title | `title` | 空标题回退域名（popup 展示层）；落库保持原样 |
| url | `urlString` | 经 `parseLink` 生成 canonical / provider / contentId |
| selectedText | `note` | 链接记录的「我的备注」位，语义是用户摘录 |
| description | `summary` | meta description / og:description 的纯文本 |
| — | `carrier` | 固定 `link` |

favicon 会被采集并在 popup 展示，但 Records 模型暂无可写字段，第一版不持久化。

## 5. 去重与并发

- Desktop 以 `requestId` 为键做 5 分钟幂等，最多缓存 200 条；
- Popup 在发送期间禁用按钮，成功后本次打开不再允许重复提交；
- Host 每次请求建立一条连接，拿到响应立即断开；
- Desktop 重启后旧 token 失效，Host 会得到 `APP_NOT_RUNNING`，下次请求自动重连。

## 6. 生命周期

| 事件 | 行为 |
|---|---|
| Desktop 启动 | 起本地 IPC → 若 Host 已安装则刷新 `host-config.json` |
| Desktop 退出 | 关闭 socket / pipe，删除 info 文件；不影响 Chrome 浏览 |
| Chrome 关闭 popup | Service Worker 结束本次连接，Host 进程退出 |
| Host 崩溃 | Chrome 只看到连接断开；下一次请求重新拉起，不影响浏览器 |
| Desktop 未启动 | Host 逐条返回 `APP_NOT_RUNNING`，不假装成功 |

## 7. 本地 IPC 安全

- **Windows**：`\\.\pipe\brewphase-chrome-v1-<userData 哈希>`；
  Node 创建的 pipe 默认只允许当前用户、SYSTEM 与 Administrators；不监听 TCP。
- **macOS / Linux**：`<userData>/chrome/bridge.sock`，目录 `0700`、socket `0600`。
- 每个实例按 userData 派生名字，多用户 / 便携实例互不抢占。
- 握手必须带 token；token 只存在 `host-config.json`（`0600`），不通过 IPC 暴露给
  Renderer，也不写日志。

## 8. 测试矩阵

| 层 | 测试 | 覆盖 |
|---|---|---|
| Desktop | `tests/unit/chrome-companion.test.ts` | PING、落库字段、去重、URL 白名单、超长拒绝、契约常量一致、IPC 握手/坏 JSON/停止 |
| Native Host | `tests/integration/chrome-host.test.ts` | 真实进程、正常帧、分段读取、Desktop 未运行、token 失配、超大帧、坏 JSON |
| Extension | `ChromeExtension/tests/*.test.ts` | 协议规范化、错误响应、DOM 提取、空选区、meta 回退 |
| 全链路 | `tests/e2e/chrome-companion.e2e.spec.ts` | 安装 → 真实 Host → 真实 IPC → Records → 响应 / 去重 |

## 9. 已知限制

- 第一版只支持 Chrome（Chromium 系可按同样 manifest 路径扩展，未验证 Edge）；
- 扩展通过 Load Unpacked 安装，未发布 Chrome Web Store；
- favicon 不落库；
- macOS / Linux 的 IPC 与注册代码已实现，但本机（Windows 11）只实测了 Windows；
- 选中文字直接进 `note`，没有单独的「摘录」字段；如果未来 Personal Desk 需要
  结构化摘录，应新增字段而不是继续挤占 `note`。
