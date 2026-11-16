# 安装 BrewPhase

BrewPhase 是三个共享同一套数据模型、但彼此独立的东西。装你想要的那个就行——用 iPhone 版不需要装桌面端。

| 你想要… | 装什么 | 需要 |
|---|---|---|
| 手机上的咖啡笔记 | [App Store 上的 BrewPhase 1.1](https://apps.apple.com/us/app/brewphase/id6815591631) | iPhone，iOS 18.0+ |
| 桌面端伴生应用（Coffee / Records / Canvas、局域网同步、MCP） | [Releases](https://github.com/banmu123/BrewPhase/releases) 里的 `BrewPhase-<版本>-mac-arm64.dmg` | Apple Silicon Mac |
| 同样装在 Windows 上 | [Releases](https://github.com/banmu123/BrewPhase/releases) 里的 `BrewPhase-<版本>-win-x64.exe` | Windows x64 |

> **只有两个地方提供安装包：** 上面的 App Store 链接，和
> [github.com/banmu123/BrewPhase/releases](https://github.com/banmu123/BrewPhase/releases)。没有第三方下载站。
> 每个 GitHub 资产都带一个 `.sha256` 校验文件，可以自己核对（见[校验下载](#校验下载)）。

哪些功能真的发出去了、哪些还只在 `main` 里，以 [docs/PROJECT_STATUS.md](PROJECT_STATUS.md) 为准。
别把这页当成发布公告读。

---

## 1. iPhone

1. 打开 [App Store 上的 BrewPhase](https://apps.apple.com/us/app/brewphase/id6815591631)。
2. 安装。免费，美区，中英双语。
3. 打开应用，添加一包豆并填上烘焙日期，然后记一次冲煮，风味时间线会自己长出来。

App Store 上是 **1.1**，也就是咖啡笔记那部分。Records、Canvas、局域网同步**不在里面**——它们在
`main` 与下面的桌面端构建里。

三个平台都没有账号，也没有登录。

---

## 2. macOS 桌面端

### 2.1 下载

打开 [Releases](https://github.com/banmu123/BrewPhase/releases)，选最新的 `desktop-v*`。两个资产，
同一个应用：

| 资产 | 什么时候用 |
|---|---|
| `BrewPhase-<版本>-mac-arm64.dmg` | 常规安装。挂载、拖拽、完事。 |
| `BrewPhase-<版本>-mac-arm64.zip` | 需要纯压缩包时（脚本安装、MDM）。解压后自己把 `BrewPhase.app` 放进 `/Applications`。 |

两个都是**仅 Apple Silicon（arm64）**。没有 Intel 构建，也没有计划——Intel Mac 会直接拒绝启动，而不是
慢慢跑。

旁边的 `.blockmap` 是增量更新用的格式文件，不是安装用的，忽略即可。

### 2.2 校验下载

把资产旁边的 `.sha256` 一起下载，然后：

```bash
cd ~/Downloads
shasum -a 256 -c BrewPhase-<版本>-mac-arm64.dmg.sha256
# BrewPhase-<版本>-mac-arm64.dmg: OK
```

校验文件内容就是 `<哈希>  <文件名>`，所以 `shasum -c` 不用改任何东西。如果结果是 `FAILED`，
删掉重新下载——不要装它。

留个底，`desktop-v0.1.4`：

```
d1a8f81b36a225524a69e588db7047e7adae8dd74db02d98df0238e2ccfa9437  BrewPhase-0.1.4-mac-arm64.dmg
```

### 2.3 安装

1. 双击 `.dmg` 挂载。
2. 把 **BrewPhase** 拖到同一窗口里的 **Applications** 文件夹。
3. 推出磁盘映像（`⌘E`，或 Finder 里的推出按钮）。
4. 从**应用程序**里启动，不要从挂载的映像里直接开——映像里的副本是只读的，推出后就没了。

### 2.4 首次启动与 Gatekeeper

`desktop-v0.1.1`、`desktop-v0.1.3`、`desktop-v0.1.4` 都是 **Developer ID 签名、Apple 公证、已 staple**。
双击就能开：不用右键，不用删 `xattr`，不用去系统设置里点「仍要打开」。

| 构建 | 签名状态 | 首次启动 |
|---|---|---|
| 0.1.4 / 0.1.3 / 0.1.1 | 已签名 + 已公证 + 已 staple | 双击 |
| 0.1.2 | 已签名，**未公证** | 右键 → **打开**，仅一次——或者干脆用 0.1.4 |
| 0.1.0 | 已签名 + 已公证 + 已 staple | 双击 |

如果在 0.1.4 上遇到「BrewPhase 已损坏，无法打开」，先按上面的 SHA-256 核对，多半是下载被截断。
**不要**去执行 `sudo spctl --master-disable`：为了开一个应用而全局关掉 Gatekeeper 不划算，这里也不需要。

仓库没有声明最低 macOS 版本。只构建过 arm64，下限由 `Desktop/package.json` 里锁定的 Electron 主版本决定——
如果应用一启动就退出，先怀疑 macOS 版本太旧。

### 2.5 数据存在哪

安装版把一切放在一个目录里，和开发版分开：

| 平台 | 目录 | 内容 |
|---|---|---|
| macOS | `~/Library/Application Support/BrewPhase/` | `brewphase.db`（SQLite）、`media/` |
| Windows | `%APPDATA%\BrewPhase\` | `brewphase.db`、`media/` |

可以换个地方——**设置 → 常规 → 本地数据 → 更改位置…**——它会把数据库与媒体复制到你选的空文件夹然后重启，
原目录不删不搬。备份就是在应用关闭时把那个目录整个复制走；没有云端副本，也没有导出服务器。

开发版（`pnpm dev`）用的是 `~/Library/Application Support/brewphase-desktop`，两者永远不会共用同一个库。

### 2.6 卸载

1. 退出 BrewPhase。
2. 把 `/Applications` 里的 **BrewPhase** 拖进废纸篓。

数据**不会**被删。要连数据一起清掉，就在应用删掉后再删
`~/Library/Application Support/BrewPhase`。这是故意的：卸载不该顺手毁掉你可能还会装回来的咖啡记录。

---

## 3. Windows 桌面端

### 3.1 下载

从 [Releases](https://github.com/banmu123/BrewPhase/releases) 最新的 `desktop-v*` 里取：

| 资产 | 什么时候用 |
|---|---|
| `BrewPhase-<版本>-win-x64.exe` | 常规安装（NSIS）。 |
| `BrewPhase-<版本>-win-x64.exe.sha256` | 校验文件——和安装包一起下。 |

仅 Windows x64。没有 arm64 Windows 构建。

### 3.2 校验下载

在下载目录里打开 PowerShell：

```powershell
Get-FileHash .\BrewPhase-<版本>-win-x64.exe -Algorithm SHA256
```

把 `Hash` 和 `.sha256` 文件里的第一段比对，必须完全一致。图形界面的替代办法：右键 `.exe` →
**属性** → **数字签名**——但当前安装包**没有** Authenticode 签名，那个标签页会是空的。能用的检查就是校验和。

### 3.3 安装

1. 运行 `.exe`。
2. SmartScreen 会拦一下——见下一节。
3. NSIS 安装器是**向导式**而不是一键式：会显示目标目录并允许修改，然后创建开始菜单项和名为 *BrewPhase*
   的桌面快捷方式。
4. 从开始菜单启动。

### 3.4 SmartScreen

Windows 安装包**没有 Authenticode 签名**，所以首次运行会看到「Windows 已保护你的电脑」：

1. 点 **更多信息**。
2. 点 **仍要运行**。

这个提示的意思是「发行者没有买证书」，不是「这个文件已知是恶意软件」。先按 3.2 核对 SHA-256；如果和 Release
里公布的一致，文件就是构建出来的那个。校验没做过的文件，不要顺手点过去。

Windows 构建**尚未**由维护者在真机上安装或冒烟测试过，请按 prerelease 对待。

### 3.5 数据存在哪

`%APPDATA%\BrewPhase\`——`brewphase.db` 和 `media/`。布局和 macOS 一致，同样可以在
**设置 → 常规 → 本地数据 → 更改位置…** 里改。

### 3.6 卸载

**设置 → 应用 → 已安装的应用 → BrewPhase → 卸载**。安装器配置了
`deleteAppDataOnUninstall: false`，所以 `%APPDATA%\BrewPhase` 会留着。想连数据一起删就手动删那个目录。

### 3.7 Windows 版做不到的事

- **没有 MCP / AI 动作网关。** 桥接走 Named Pipe，其权限在 Windows 上尚未验证；应用自己的
  *设置 → 常规 → 本版刻意不做* 里就列了这一条。MCP 只在 macOS 上可用。
- **没有 Authenticode 签名**——每次重新下载都会被 SmartScreen 拦。
- **没有真机验证**——见上。

---

## 4. 升级

两个平台都**没有自动更新安装器**（没有接 `electron-updater`）。应用只会告诉你有没有新版本。

- **检查：** **设置 → 常规 → 检查更新**。BrewPhase 启动时会读一次最新的 GitHub Release，有新版本就在侧栏
  显示提示徽标。它不上传任何关于你或你的数据的东西，只取版本号。
- **升级：** 从 Releases 下载新的 `.dmg` / `.exe` 覆盖安装。`brewphase.db` 与 `media/` 在应用包外面，会保留。
  装之前先退出应用。
- **回退：** 各版本相互独立，用旧版覆盖新版能装上；但被新版写过一次的数据库，旧版可能读不了。降级前先把
  `Application Support/BrewPhase` 复制一份。

---

## 5. 把 iPhone 和桌面端配对

两台设备连同一个 Wi-Fi。

1. 桌面端：**设置 → 设备同步** → 显示配对二维码。
2. iPhone：Coffee 首页的 **连接桌面端** 卡片，或 **更多 → 数据 → 桌面同步**。
3. 扫码。配对码一次性使用，两分钟过期。

v1 的同步是**单向的：iOS → 桌面端**。手机推，桌面端收。配对与同步在你的局域网里走明文 HTTP——
用 token 加时间戳 / nonce / HMAC 做认证，但**不加密**。只在信任的网络里配对。细节见
[`Desktop/docs/REAL_DEVICE_SYNC_GUIDE.md`](../Desktop/docs/REAL_DEVICE_SYNC_GUIDE.md)、
[`Desktop/docs/SYNC_PROTOCOL.md`](../Desktop/docs/SYNC_PROTOCOL.md)。

---

## 6. 用 MCP 接一个 AI 智能体（仅 macOS）

1. 桌面端：**设置 → AI 连接** → 建一个客户端 token，选你需要的 scope（共 8 种）。token 只显示一次。
2. 把 MCP 客户端指向已安装应用里的服务端：

   ```
   /Applications/BrewPhase.app/Contents/Resources/mcp/stdio.mjs
   ```

   这是个自包含的单文件，直接用 `node` spawn 即可，不用 `npm install`，不用构建。
3. token 通过环境变量 `BREWPHASE_MCP_TOKEN` 传，不要写进命令行参数。

可直接复制的 `config.toml` / `mcp.json` 在
[`Desktop/README.md`](../Desktop/README.md#mcpai-action-gateway)。工具清单与边界见
[`Desktop/docs/MCP_TOOLS.md`](../Desktop/docs/MCP_TOOLS.md)、
[`Desktop/docs/MCP_SECURITY.md`](../Desktop/docs/MCP_SECURITY.md)——按设计没有 SQL、文件系统和删除类工具。

Windows：不可用，见 3.7。

---

## 7. 故障排查

| 现象 | 多半是 | 怎么办 |
|---|---|---|
| macOS：「BrewPhase 已损坏，无法打开」 | 下载被截断，或用的是老的 0.1.2 | 先核对 SHA-256（2.2）；不通过就重下。通过了说明你在 0.1.2，换 0.1.4 |
| macOS：「你没有权限打开该应用程序」 | 还在挂载的 `.dmg` 里直接运行 | 拖到 `/Applications`，从那里启动 |
| macOS：「此应用不支持这台 Mac」 | Intel 机器 | 没有 Intel 构建，无法解决 |
| macOS：一启动就退出 | macOS 低于 Electron 运行时要求 | 升级 macOS，或查 `Desktop/package.json` 里的 Electron 主版本 |
| Windows：「Windows 已保护你的电脑」 | 安装包未签名 | 核对校验和之后，**更多信息 → 仍要运行** |
| Windows：装完启动不了 | 杀毒软件隔离了未签名二进制 | 查杀毒隔离记录；确认过校验和再加白名单 |
| 打开应用看到自己没加过的豆子 | 开发版共用了旧的 `brewphase-desktop` 目录 | 安装版用 `Application Support/BrewPhase`，旧目录没动，可以自己删 |
| iPhone 一直搜不到桌面端 | 不在同一网络、开了 VPN，或二维码过期 | 同一 Wi-Fi、关 VPN、重新生成再扫 |
| 配对成功但没数据进来 | v1 只支持 iOS → 桌面端 | 桌面端的改动不会推回手机 |
| MCP 客户端报找不到模块 | 用了相对路径，或指向源码目录 | 用第 6 节第 2 步里的绝对路径 |
| 更新提示一直不出现 | 离线，或 GitHub API 被限流 | 稍后手动点「检查更新」；这个检查是只读的 |

还卡着就去 [github.com/banmu123/BrewPhase/issues](https://github.com/banmu123/BrewPhase/issues) 开 issue，
带上平台、应用版本（**设置 → 常规 → 应用**）和完整的报错文字。

---

## 8. 这些构建刻意不做的事

单独列一遍，因为这是最容易踩的预期差：

- 没有云同步、没有账号、没有遥测——手机和桌面端要么直连，要么不连。
- 没有自动更新安装，新版本自己下。
- 没有 Intel macOS 构建，没有 arm64 Windows 构建，没有 Linux 构建。
- Windows 上没有 MCP 桥。
- 局域网同步是未加密的 HTTP（有认证，但不保证机密性）。
- Records / Canvas / 桌面同步**不在** App Store 的 1.1 里。

带日期的权威限制清单见 [`docs/PROJECT_STATUS.md`](PROJECT_STATUS.md) §8。
