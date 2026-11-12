# BrewPhase Chrome Companion

在已经登录的 Chrome 里浏览网页，点一下扩展，把当前页面与选中的文字保存到 BrewPhase Desktop 的 Records。

不复制 Cookie、不共享浏览器 Profile、不要求重新登录：Chrome 负责上网，BrewPhase 负责沉淀内容。

## 架构

```text
Chrome Extension (MV3, React popup)
      │  chrome.runtime.connectNative('com.brewphase.chrome')
      ▼
Native Messaging Host (Rust, 独立可执行文件)
      │  NDJSON over local IPC
      │  Windows: \\.\pipe\brewphase-chrome-v1-<hash>
      │  macOS/Linux: <userData>/chrome/bridge.sock
      ▼
BrewPhase Desktop (Electron main)
      │  Zod 校验 → RecordService.createFromChrome
      ▼
SQLite (records / record_metadata)
```

职责边界：

- **Popup** 只在用户点击时用 `activeTab` + `chrome.scripting.executeScript` 读取当前标签页；
- **Service Worker** 只做转发，不缓存网页内容；
- **Native Host** 只做 Chrome 帧协议与本机 IPC 的桥接，不解析网页字段、不写数据库；
- **Desktop** 是唯一的业务入口：校验、去重、落库、广播 `records` 事件。

## 目录

```text
ChromeExtension/
├── manifest.json / popup.html        # 源（manifest 在 public/，构建时带 key）
├── extension-id.json                 # 固定 Extension ID（公钥，可公开）
├── native-host/                      # Rust Native Host（无第三方依赖）
├── scripts/
│   ├── build-host.mjs                # cargo build + 复制到 Desktop/resources
│   ├── extension-id.mjs              # 生成 / 复用固定 ID 并写入 manifest
│   ├── install-host.mjs              # 开发环境注册（CLI）
│   ├── uninstall-host.mjs            # 清理注册
│   ├── postbuild.mjs                 # 校验 dist（key、入口文件）
│   └── generate-icons.mjs            # 生成 16/32/48/128 图标
├── src/background/service-worker.ts
├── src/popup/                        # React popup
├── src/lib/page-metadata.ts          # 注入页面的提取函数
├── src/lib/native-messaging.ts       # connectNative 封装
├── src/shared/protocol.ts            # 与 Desktop 对齐的协议常量/类型
└── tests/                            # Vitest（协议 + DOM 提取）
```

## 开发环境

- Node.js 22+、pnpm 9+
- Rust 工具链（`cargo`）——只用于构建 Native Host
- Chrome 116+

```bash
cd ChromeExtension
pnpm install
pnpm build          # 构建扩展 → ChromeExtension/dist
pnpm host:build     # 构建 Host → Desktop/resources/native-host/<platform>/
```

`pnpm build` 会把 `extension-id.json` 里的公钥写进 `dist/manifest.json`，因此
Load Unpacked 的 Extension ID 是固定的：

```
fohjelihijmiefmjadckiajickopdojn
```

换机器、换目录都不会变。**不要**在未重新生成 ID 的情况下修改 `extension-id.json`，
否则 Native Host 的 `allowed_origins` 会失配。

## 安装 Native Host

两种方式等价：

1. **Desktop 设置页**（推荐）：设置 → Chrome 扩展 → 「安装 / 修复」。
   Desktop 会把 Host 复制到用户目录、写 `host-config.json`（含本次启动的 token）、
   写 Native Messaging manifest，并在 Windows 写
   `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.brewphase.chrome`。
2. **CLI**（无 Desktop 时）：

   ```bash
   cd ChromeExtension
   pnpm host:build
   node scripts/install-host.mjs
   ```

   然后重启一次 BrewPhase Desktop，让 `host-config.json` 拿到 endpoint 与 token。

安装目录：

| 平台 | Host 安装目录 | Manifest 位置 |
|---|---|---|
| Windows | `%LOCALAPPDATA%\BrewPhase\ChromeCompanion` | 同目录，注册表指向它 |
| macOS | `~/Library/Application Support/BrewPhase/ChromeCompanion` | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.brewphase.chrome.json` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/brewphase/chrome-companion` | `~/.config/google-chrome/NativeMessagingHosts/com.brewphase.chrome.json` |

安装是幂等的；Desktop 每次启动会刷新 `host-config.json`（token 轮换），
旧 token 立即失效。

## 在 Chrome 加载扩展

1. 打开 `chrome://extensions`；
2. 右上角开启「开发者模式」；
3. 点「加载已解压的扩展程序」，选择 **`ChromeExtension/dist`**（不是源码目录）；
4. 确认卡片上的 ID 是 `fohjelihijmiefmjadckiajickopdojn`；
5. 建议固定到工具栏。

改完扩展代码后：`pnpm build`，回到 `chrome://extensions` 点该卡片的刷新按钮。

## 验证连接

1. 启动 BrewPhase Desktop；
2. 随便打开一个 `http(s)` 页面；
3. 点扩展图标：右上角应显示「已连接」；页面卡片显示标题、域名、URL；
4. 选中一段文字再打开 popup，会多出「选中的文字」预览；
5. 点「保存到 BrewPhase」→ 显示「已保存到 BrewPhase Records」；
6. 打开 BrewPhase 的 Records，能看到这条记录（标题 / 链接 / 备注里的选中文字）。

如果显示「未运行」：确认 Desktop 正在运行，并且设置 → Chrome 扩展显示
「已安装，等待连接」或「已连接」。
如果一直「连接中」：看下一节的调试方法。

## 右键菜单与截图

页面里右键有 BrewPhase 菜单：

- **保存当前网页到 Records** — 等价于 popup 的保存；
- **保存选中的文字** — 选中文字先划好再右键，直接进 Records；
- **保存图片到 BrewPhase** — 定位右键的 `<img>`，用当前可见区域截屏裁出
  图片像素，然后打开 Capture 编辑页（预览 / 选中文字 / 我的备注）确认保存。
  图片不在可见区域或找不到元素时会如实提示，不会静默保存链接。

Popup 里的 **截图当前页面** 按钮截取当前可见区域，同样进入 Capture 编辑页。
截图草稿只放在 `chrome.storage.session`（随浏览器会话消失、不上云），
保存成功或取消后立即清除。

Capture 页保存的记录是 `image` 类型：截图真实写入 Desktop 的媒体目录
（展示图 + 缩略图），`note` 按「【网页摘录】/【我的备注】/【来源】」三段保存，
图片经 96KB 分块 + SHA-256 校验传输，SQLite 里不存 base64。

## 调试

- **扩展**：`chrome://extensions` → BrewPhase 卡片 → 「Service Worker」/「错误」。
  Popup 的 console 也可以从卡片里的「检查视图」打开。
- **Native Host**：Host 的所有日志都写 **stderr**（stdout 只允许 Native Messaging 帧）。
  Chrome 会把 Host 的 stderr 收进扩展的错误页；也可以从终端直接跑：

  ```bash
  BREWPHASE_CHROME_HOST_CONFIG=<host-dir>/host-config.json <host-dir>/brewphase-chrome-host
  ```

  然后按 Chrome 的帧格式写 stdin（4 字节 native-endian 长度 + JSON）。
- **Desktop**：主进程日志里搜索 `[chrome]` / `[chrome-bridge]`；
  错误日志只记录错误类型与 requestId，不打印 URL、标题或选中文字。
- **协议测试**：`Desktop/tests/integration/chrome-host.test.ts` 会真的 spawn Host，
  可以照着它写临时诊断脚本。

## 卸载

```bash
cd ChromeExtension
node scripts/uninstall-host.mjs
```

或在设置 → Chrome 扩展点「移除集成」。两者都会删除：

- `com.brewphase.chrome` 的注册表项 / manifest；
- `BrewPhase/ChromeCompanion` 目录（Host 与 config）。

不会删除 Chrome 里的扩展本体——那一步在 `chrome://extensions` 里点「移除」。
也不会碰其他应用注册的 Native Messaging Host。

## 生产打包

- Host 是 Rust 编译的独立可执行文件，**不依赖用户安装 Node.js**；
- `electron-builder.yml` 已按平台配置 `extraResources`：
  `resources/native-host/<platform>/` → 安装包的 `resources/native-host/`；
- 发布前在对应平台执行 `pnpm host:build`，确保目录里有二进制：

  ```bash
  # macOS（在 mac 上执行）
  cargo build --release --target aarch64-apple-darwin
  cargo build --release --target x86_64-apple-darwin
  # Linux（在 linux 上执行）
  cargo build --release
  ```

  `build-host.mjs` 目前复制本机 `cargo build --release` 的产物；交叉编译时
  把产物放到 `Desktop/resources/native-host/<platform>/` 即可。

- **固定 Extension ID**：开发用 `ChromeExtension/extension-id.json` 里的公钥；
  正式发布时把 Chrome Web Store 的固定公钥写进同一文件，或设置环境变量
  `BREWPHASE_CHROME_EXTENSION_ID=<store-id>`（Desktop 打包运行时读取）。
- 生产版不应包含开发机的绝对路径：Host 安装时会复制到用户目录并重新生成
  manifest，路径来自 `app.getAppPath()` / `process.resourcesPath`，不是仓库路径。

## 平台支持

| 平台 | 本地 IPC | 注册 | 状态 |
|---|---|---|---|
| Windows 10/11 | Named Pipe | `HKCU` 注册表 | 已在本机实测（Windows 11 + Chrome） |
| macOS | Unix domain socket | `~/Library/.../NativeMessagingHosts` | 代码路径已实现，未在本机实测 |
| Linux | Unix domain socket | `~/.config/google-chrome/...` | 代码路径已实现，未在本机实测 |

## 测试

```bash
cd ChromeExtension
pnpm typecheck
pnpm test        # 协议 + 页面提取（happy-dom）

cd ../Desktop
pnpm typecheck
npx vitest run tests/unit/chrome-companion.test.ts       # 协议 / 落库 / 去重 / IPC
npx vitest run tests/integration/chrome-host.test.ts     # 真实 Host 进程
npx playwright test tests/e2e/chrome-companion.e2e.spec.ts  # 真实 Electron 全链路
```

## 安全边界

- 权限只有 `activeTab`、`scripting`、`nativeMessaging`、`contextMenus`；没有
  `cookies`、`history`、`webRequest`，也没有 `<all_urls>`；
  `contextMenus` 只用于注册右键菜单项，不读取任何浏览数据；
- 只在用户点击扩展 / 菜单时读取**当前**标签页；没有 content script 常驻、没有后台扫描；
- 截图（`captureVisibleTab`）与图片裁剪只在用户主动操作时执行一次；
- 不读 Cookie / localStorage / 表单值 / 密码，不复制 Chrome Profile；
- 网页内容只作为不可信文本处理：Desktop 用 Zod 校验长度与协议，React 默认转义；
- 图片传输逐块校验顺序、字节数与 SHA-256，签名不符（非 PNG/JPEG）直接拒绝；
- 本地 IPC 只监听本机（Named Pipe / Unix socket），不监听 TCP；
  握手 token 每次 Desktop 启动轮换；socket 目录 0700、文件 0600；
- Host 只转发，不执行网页传来的任何命令；Desktop 不向网页暴露任何接口。
